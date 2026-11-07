/**
 * 文筆エンジン (the writing engines).
 *
 * 3 つの制作領域 — 歌詞・小説・記事 — を支える。ここには 2 種類のものだけを置く。
 *
 * 1. 決定的な職人仕事: モーラ数・韻・組版・読み時間。これらは LLM を介さず、
 *    同じ入力から常に同じ答えを返す。だから生成物を機械で検証できる。
 * 2. 薄い LLM ブリッジ: ルート解決・ストリームの集約・打ち切り。文章そのものは
 *    ハーネスの `llm` サービスに書かせる。
 *
 * プロンプトは「専門家の判断基準」をそのまま持ち込む。ここが品質の本体で、
 * 残りはその出力を検査する道具である。
 */

const TAU = Math.PI * 2;

/** Language codes these engines understand. */
export const WRITING_LANGUAGES = ['ja', 'en'];

/** Genres a lyric can be written in. */
export const LYRIC_GENRES = ['jpop', 'rock', 'ballad', 'rap', 'edm', 'folk', 'citypop', 'anison', 'metal', 'rnb'];

/** Section presets, in performance order. */
export const LYRIC_STRUCTURES = {
  'jpop-standard': ['Intro', 'Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Final Chorus', 'Outro'],
  'western-pop': ['Verse 1', 'Pre-Chorus', 'Chorus', 'Verse 2', 'Pre-Chorus', 'Chorus', 'Bridge', 'Chorus'],
  aaba: ['Verse 1', 'Verse 2', 'Bridge', 'Verse 3'],
  'rap-16': ['Intro', 'Verse 1', 'Hook', 'Verse 2', 'Hook', 'Outro'],
  'edm-drop': ['Verse', 'Build', 'Drop', 'Verse', 'Build', 'Drop', 'Outro'],
  ballad: ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Bridge', 'Final Chorus'],
  '12-bar': ['Verse 1', 'Verse 2', 'Verse 3'],
};

/** Article formats and the convention each one actually follows. */
export const ARTICLE_FORMATS = {
  news: 'inverted pyramid: the single most important fact first, then detail in descending importance, then background',
  howto: 'numbered steps in the order a reader performs them, prerequisites first, one action per step, expected result stated',
  listicle: 'a promise in the intro, then N items each with a concrete example, ordered by usefulness rather than by list position',
  comparison: 'an explicit criteria table in prose form, then a recommendation per reader type, then the trade-offs nobody mentions',
  review: 'verdict first, then the evidence behind it, then who it is for and who should skip it',
  'thought-leadership': 'a contrarian but defensible claim, the reasoning that supports it, the counter-argument answered, the implication for the reader',
  'press-release': 'dateline, lead paragraph with who/what/when/where/why, quote, supporting detail, boilerplate, contact',
  'product-page': 'the reader problem, the outcome, the mechanism, proof, objection handling, one call to action',
  column: 'a personal observation that opens a question, the widening context, the conclusion the reader can use',
  tutorial: 'the finished result shown first, then the shortest path to it, with every prerequisite and failure mode named',
};

/**
 * Simplified Chinese forms that a Japanese model occasionally emits.
 *
 * They are never correct in Japanese prose, and each has exactly one Japanese
 * counterpart, so repairing them is safe rather than a guess.
 */
const SIMPLIFIED_TO_JAPANESE = new Map(
  Object.entries({
    热: '熱',
    门: '門',
    电: '電',
    车: '車',
    铁: '鉄',
    见: '見',
    说: '説',
    对: '対',
    时: '時',
    间: '間',
    关: '関',
    长: '長',
    马: '馬',
    鸟: '鳥',
    鱼: '魚',
    贝: '貝',
    页: '頁',
    风: '風',
    飞: '飛',
    觉: '覚',
    头: '頭',
    买: '買',
    卖: '売',
    东: '東',
    华: '華',
    无: '無',
    发: '発',
    让: '譲',
    还: '還',
    这: '這',
    们: '們',
    个: '個',
    儿: '児',
    团: '団',
    园: '園',
    图: '図',
    实: '実',
    军: '軍',
    农: '農',
    净: '浄',
    减: '減',
    岁: '歳',
    广: '広',
    庆: '慶',
    应: '応',
    举: '挙',
    义: '義',
    乐: '楽',
    习: '習',
    书: '書',
    亚: '亜',
    产: '産',
    传: '伝',
    优: '優',
    伟: '偉',
    伤: '傷',
    兰: '蘭',
    兴: '興',
    养: '養',
    兽: '獣',
    决: '決',
    况: '況',
    冻: '凍',
    凤: '鳳',
    击: '撃',
    则: '則',
    刚: '剛',
    创: '創',
    别: '別',
    剂: '剤',
    剑: '剣',
    剧: '劇',
    劝: '勧',
    办: '弁',
    务: '務',
    动: '動',
    劳: '労',
    势: '勢',
    协: '協',
    单: '単',
    卫: '衛',
    历: '歴',
    压: '圧',
    县: '県',
    变: '変',
    叹: '嘆',
    听: '聴',
    启: '啓',
    员: '員',
    响: '響',
    哑: '唖',
    哗: '嘩',
    唤: '喚',
    问: '問',
    喷: '噴',
    圣: '聖',
    场: '場',
    坏: '壊',
    坟: '墳',
    坠: '墜',
    垒: '塁',
    垦: '墾',
    恶: '悪',
    恼: '悩',
    悬: '懸',
    惊: '驚',
    惩: '懲',
    惫: '憊',
    惯: '慣',
    愤: '憤',
    愿: '願',
    戏: '戯',
    战: '戦',
    户: '戸',
    扑: '撲',
    执: '執',
    扩: '拡',
    扫: '掃',
    扬: '揚',
    扰: '擾',
    抚: '撫',
    抢: '搶',
    护: '護',
    报: '報',
    拟: '擬',
    拥: '擁',
    拦: '攔',
    拨: '撥',
    择: '択',
    挂: '掛',
    挚: '摯',
    挠: '撓',
    挡: '擋',
    挣: '掙',
    挤: '擠',
    损: '損',
    捡: '撿',
    换: '換',
    捣: '搗',
    掷: '擲',
    揽: '攬',
    搀: '攙',
    搁: '擱',
    搂: '摟',
    搅: '攪',
    摄: '摂',
    摆: '擺',
    摇: '揺',
    摊: '攤',
    敌: '敵',
    敛: '斂',
    斋: '斎',
    斩: '斬',
    旷: '曠',
    昙: '曇',
    显: '顕',
    晓: '暁',
    晕: '暈',
    暂: '暫',
    术: '術',
    杀: '殺',
    杂: '雑',
    权: '権',
    极: '極',
    构: '構',
    枪: '槍',
    枫: '楓',
    柜: '櫃',
    标: '標',
    栈: '桟',
    栋: '棟',
    栏: '欄',
    树: '樹',
    样: '様',
    桥: '橋',
    桦: '樺',
    桨: '槳',
    桩: '樁',
    梦: '夢',
    检: '検',
    椭: '橢',
    欢: '歓',
    歼: '殲',
    殒: '殞',
    毕: '畢',
    毙: '斃',
    气: '気',
    汉: '漢',
    汤: '湯',
    沟: '溝',
    沦: '淪',
    沧: '滄',
    泪: '涙',
    泻: '瀉',
    泼: '潑',
    泽: '沢',
    洁: '潔',
    洼: '窪',
    浆: '漿',
    浇: '澆',
    浊: '濁',
    测: '測',
    济: '済',
    浑: '渾',
    浓: '濃',
    涂: '塗',
    涤: '滌',
    润: '潤',
    涧: '澗',
    涨: '漲',
    涩: '渋',
    渊: '淵',
    渍: '漬',
    渐: '漸',
    渔: '漁',
    渗: '滲',
    溃: '潰',
    溅: '濺',
    滚: '滾',
    满: '満',
    滤: '濾',
    滥: '濫',
    滨: '浜',
    滩: '灘',
    灭: '滅',
    灵: '霊',
    灾: '災',
    灿: '燦',
    烛: '燭',
    烟: '煙',
    烦: '煩',
    烧: '焼',
    烫: '燙',
    焕: '煥',
    爱: '愛',
    爷: '爺',
    牵: '牽',
    牺: '犠',
    犹: '猶',
    狮: '獅',
    猎: '猟',
    环: '環',
    现: '現',
    玺: '璽',
    琐: '瑣',
    琼: '瓊',
    疗: '療',
    疮: '瘡',
    瘫: '癱',
    皱: '皺',
    盐: '塩',
    监: '監',
    盖: '蓋',
    盘: '盤',
    瞒: '瞞',
    矫: '矯',
    码: '碼',
    砖: '磚',
    砚: '硯',
    础: '礎',
    硕: '碩',
    确: '確',
    祸: '禍',
    离: '離',
    种: '種',
    积: '積',
    秽: '穢',
    稳: '穏',
    穷: '窮',
    窍: '竅',
    窜: '竄',
    窝: '窩',
    窥: '窺',
    竞: '競',
    笔: '筆',
    笋: '筍',
    筑: '築',
    筛: '篩',
    筹: '籌',
    签: '簽',
    简: '簡',
    篮: '籃',
    类: '類',
    粮: '糧',
    紧: '緊',
    红: '紅',
    纠: '糾',
    纪: '紀',
    约: '約',
    级: '級',
    纫: '紉',
    纬: '緯',
    纯: '純',
    纱: '紗',
    纲: '綱',
    纳: '納',
    纵: '縦',
    纷: '紛',
    纸: '紙',
    纹: '紋',
    纺: '紡',
    纽: '紐',
    线: '線',
    练: '練',
    组: '組',
    细: '細',
    织: '織',
    终: '終',
    绊: '絆',
    绍: '紹',
    经: '経',
    绒: '絨',
    结: '結',
    绕: '繞',
    绘: '絵',
    给: '給',
    络: '絡',
    绝: '絶',
    绞: '絞',
    统: '統',
    继: '継',
    绩: '績',
    绪: '緒',
    续: '続',
    绳: '縄',
    维: '維',
    绵: '綿',
    绷: '繃',
    综: '総',
    绽: '綻',
    绿: '緑',
    缀: '綴',
    缅: '緬',
    缆: '纜',
    缓: '緩',
    缔: '締',
    编: '編',
    缘: '縁',
    缝: '縫',
    缠: '纏',
    缩: '縮',
    缴: '繳',
    网: '網',
    罗: '羅',
    罚: '罰',
    罢: '罷',
    翘: '翹',
    耻: '恥',
    聋: '聾',
    职: '職',
    联: '連',
    聪: '聡',
    肃: '粛',
    肠: '腸',
    肤: '膚',
    肾: '腎',
    胀: '脹',
    胁: '脅',
    胜: '勝',
    胧: '朧',
    胫: '脛',
    胶: '膠',
    脉: '脈',
    脏: '臓',
    脐: '臍',
    脑: '脳',
    脓: '膿',
    脸: '顔',
    腊: '臘',
    腾: '騰',
    舆: '輿',
    舰: '艦',
    舱: '艙',
    艰: '艱',
    艳: '艶',
    艺: '芸',
    节: '節',
    苍: '蒼',
    苏: '蘇',
    茧: '繭',
    荐: '薦',
    荣: '栄',
    药: '薬',
    莲: '蓮',
    获: '獲',
    莹: '瑩',
    莺: '鶯',
    萝: '蘿',
    营: '営',
    萧: '蕭',
    萨: '薩',
    蓝: '藍',
    蔷: '薔',
    蔼: '藹',
    蕴: '蘊',
    藓: '蘚',
    虏: '虜',
    虑: '慮',
    虽: '雖',
    蚀: '蝕',
    蚁: '蟻',
    蛰: '蟄',
    蜡: '蝋',
    蝇: '蝿',
    蝎: '蠍',
    蝼: '螻',
    衅: '釁',
    衔: '銜',
    补: '補',
    衬: '襯',
    袄: '襖',
    袭: '襲',
    裆: '襠',
    裤: '褲',
    观: '観',
    规: '規',
    觅: '覓',
    视: '視',
    览: '覧',
    觊: '覬',
    觎: '覦',
    觐: '覲',
    觑: '覷',
    誊: '謄',
    计: '計',
    订: '訂',
    讣: '訃',
    认: '認',
    讥: '譏',
    讧: '訌',
    讨: '討',
    讪: '訕',
    讫: '訖',
    训: '訓',
    议: '議',
    讯: '訊',
    记: '記',
    讲: '講',
    讳: '諱',
    讴: '謳',
    讵: '詎',
    讶: '訝',
    讷: '訥',
    许: '許',
    讹: '訛',
    论: '論',
    讼: '訟',
    讽: '諷',
    设: '設',
    访: '訪',
    诀: '訣',
    证: '証',
    诂: '詁',
    诃: '訶',
    评: '評',
    诅: '詛',
    识: '識',
    诈: '詐',
    诉: '訴',
    诊: '診',
    诋: '詆',
    诌: '謅',
    词: '詞',
    诎: '詘',
    诏: '詔',
    译: '訳',
    诒: '詒',
    诓: '誆',
    诔: '誄',
    试: '試',
    诖: '詿',
    诗: '詩',
    诘: '詰',
    诙: '詼',
    诚: '誠',
    诛: '誅',
    诜: '詵',
    话: '話',
    诞: '誕',
    诟: '詬',
    诠: '詮',
    诡: '詭',
    询: '詢',
    诣: '詣',
    诤: '諍',
    该: '該',
    详: '詳',
    诧: '詫',
    诨: '諢',
    诩: '詡',
    诫: '誡',
    诬: '誣',
    语: '語',
    诮: '誚',
    误: '誤',
    诰: '誥',
    诱: '誘',
    诲: '誨',
    诳: '誑',
    诵: '誦',
    诶: '誒',
    请: '請',
    诸: '諸',
    诹: '諏',
    诺: '諾',
    读: '読',
    诼: '諑',
    诽: '誹',
    课: '課',
    诿: '諉',
    谀: '諛',
    谁: '誰',
    谂: '諗',
    调: '調',
    谄: '諂',
    谅: '諒',
    谆: '諄',
    谇: '誶',
    谈: '談',
    谊: '誼',
    谋: '謀',
    谌: '諶',
    谍: '諜',
    谎: '謊',
    谏: '諫',
    谐: '諧',
    谑: '謔',
    谒: '謁',
    谓: '謂',
    谔: '諤',
    谕: '諭',
    谖: '諼',
    谗: '讒',
    谘: '諮',
    谙: '諳',
    谚: '諺',
    谛: '諦',
    谜: '謎',
    谝: '諞',
    谟: '謨',
    谠: '讜',
    谡: '謖',
    谢: '謝',
    谣: '謡',
    谤: '謗',
    谥: '諡',
    谦: '謙',
    谧: '謐',
    谨: '謹',
    谩: '謾',
    谪: '謫',
    谬: '謬',
    谭: '譚',
    谮: '譖',
    谯: '譙',
    谰: '讕',
    谱: '譜',
    谲: '譎',
    谳: '讞',
    谴: '譴',
    谵: '譫',
    谶: '讖',
    贯: '貫',
    贰: '弐',
    贱: '賎',
    贲: '賁',
    贴: '貼',
    贵: '貴',
    贷: '貸',
    贸: '貿',
    费: '費',
    贺: '賀',
    贻: '貽',
    贼: '賊',
    贾: '賈',
    贿: '賄',
    赁: '賃',
    赂: '賂',
    赃: '贓',
    资: '資',
    赅: '賅',
    赈: '賑',
    赊: '賒',
    赋: '賦',
    赌: '賭',
    赎: '贖',
    赏: '賞',
    赐: '賜',
    赓: '賡',
    赔: '賠',
    赖: '頼',
    赘: '贅',
    赚: '賺',
    赛: '賽',
    赝: '贗',
    赞: '賛',
    赠: '贈',
    赡: '贍',
    赢: '贏',
    赣: '贛',
    赵: '趙',
    赶: '趕',
    趋: '趨',
    跃: '躍',
    跄: '蹌',
    跷: '蹺',
    跸: '蹕',
    跹: '躚',
    跻: '躋',
    踌: '躊',
    踬: '躓',
    踯: '躑',
    蹒: '蹣',
    躏: '躪',
    躜: '躦',
    轧: '軋',
    轨: '軌',
    轩: '軒',
    轫: '軔',
    转: '転',
    轭: '軛',
    轮: '輪',
    软: '軟',
    轰: '轟',
    轴: '軸',
    轶: '軼',
    轸: '軫',
    轹: '轢',
    轻: '軽',
    轼: '軾',
    载: '載',
    轿: '轎',
    较: '較',
    辄: '輒',
    辅: '輔',
    辆: '両',
    辇: '輦',
    辈: '輩',
    辉: '輝',
    辊: '輥',
    辍: '輟',
    辎: '輜',
    辏: '輳',
    辐: '輻',
    辑: '輯',
    输: '輸',
    辔: '轡',
    辕: '轅',
    辖: '轄',
    辗: '輾',
    辘: '轆',
    辙: '轍',
    边: '辺',
    辽: '遼',
    达: '達',
    迁: '遷',
    过: '過',
    迈: '邁',
    运: '運',
    进: '進',
    远: '遠',
    违: '違',
    连: '連',
    迟: '遅',
    迩: '邇',
    迹: '跡',
    适: '適',
    选: '選',
    逊: '遜',
    递: '逓',
    逻: '邏',
    遗: '遺',
    邓: '鄧',
    邝: '鄺',
    邬: '鄔',
    邮: '郵',
    邹: '鄒',
    邺: '鄴',
    邻: '隣',
    郑: '鄭',
    郓: '鄆',
    郦: '酈',
    郧: '鄖',
    郸: '鄲',
    酝: '醞',
    酿: '醸',
    鉴: '鑑',
    銮: '鑾',
    錾: '鏨',
    钉: '釘',
    钊: '釗',
    钋: '釙',
    钌: '釕',
    钍: '釷',
    钎: '釬',
    钏: '釧',
    钐: '釤',
    钒: '釩',
    钓: '釣',
    钕: '釹',
    钗: '釵',
    钟: '鐘',
    钢: '鋼',
    钣: '鈑',
    钥: '鑰',
    钦: '欽',
    钧: '鈞',
    钩: '鉤',
    钮: '鈕',
    钱: '銭',
    钳: '鉗',
    钵: '鉢',
    钹: '鈸',
    钺: '鉞',
    钻: '鑽',
    铃: '鈴',
    铅: '鉛',
    铎: '鐸',
    铐: '銬',
    铜: '銅',
    铭: '銘',
    铮: '錚',
    铲: '鏟',
    铳: '銃',
    银: '銀',
    铸: '鋳',
    铺: '舗',
    链: '鎖',
    铿: '鏗',
    销: '銷',
    锁: '鎖',
    锄: '鋤',
    锅: '鍋',
    锈: '銹',
    锉: '銼',
    锋: '鋒',
    锐: '鋭',
    错: '錯',
    锚: '錨',
    锡: '錫',
    锢: '錮',
    锣: '鑼',
    锤: '錘',
    锥: '錐',
    锦: '錦',
    锭: '錠',
    键: '鍵',
    锯: '鋸',
    锲: '鍥',
    锵: '鏘',
    锷: '鍔',
    锹: '鍬',
    锻: '鍛',
    镀: '鍍',
    镂: '鏤',
    镇: '鎮',
    镊: '鑷',
    镌: '鎸',
    镐: '鎬',
    镖: '鏢',
    镛: '鏞',
    镜: '鏡',
    镣: '鐐',
    镫: '鐙',
    镬: '鑊',
    镯: '鐲',
    镰: '鎌',
    镳: '鑣',
    闪: '閃',
    闭: '閉',
    闯: '闖',
    闲: '閑',
    闷: '悶',
    闹: '鬧',
    闻: '聞',
    阀: '閥',
    阁: '閣',
    阅: '閲',
    阔: '闊',
    队: '隊',
    阳: '陽',
    阴: '陰',
    阵: '陣',
    阶: '階',
    际: '際',
    陆: '陸',
    陈: '陳',
    陕: '陝',
    险: '険',
    隐: '隠',
    难: '難',
    雏: '雛',
    吗: '嗎',
    吨: '噸',
    呜: '嗚',
    围: '囲',
    圆: '円',
    块: '塊',
    坚: '堅',
    坝: '塀',
    拢: '攏',
    拣: '揀',
    拧: '擰',
    挛: '攣',
    捞: '撈',
    掳: '擄',
    掸: '撣',
    掺: '摻',
    摈: '擯',
    撵: '攆',
    撷: '擷',
    撸: '擼',
    攒: '攢',
    晖: '暉',
    暧: '曖',
    杨: '楊',
    柠: '檸',
    桧: '檜',
    榄: '欖',
    榈: '櫚',
    榉: '櫸',
    槛: '檻',
    槟: '檳',
    橱: '櫥',
    橹: '櫓',
    橼: '櫞',
    毡: '氈',
    汇: '匯',
    汹: '洶',
    沥: '瀝',
    沪: '滬',
    泞: '濘',
    泷: '瀧',
    泸: '瀘',
    泾: '涇',
    浃: '浹',
    渎: '瀆',
    滢: '瀅',
    潇: '瀟',
    澜: '瀾',
    濑: '瀬',
    濒: '瀕',
    炖: '燉',
    炜: '煒',
    烁: '爍',
    烂: '爛',
    烨: '燁',
    烩: '燴',
    烬: '燼',
    焖: '燜',
    熏: '燻',
    牍: '牘',
    牦: '犛',
    犊: '犢',
    犷: '獷',
    犸: '獁',
    狈: '狽',
    狞: '獰',
    猕: '獼',
    猡: '玀',
    猬: '蝟',
    珐: '琺',
    珑: '瓏',
    珲: '琿',
    琏: '璉',
    瑶: '瑤',
    璎: '瓔',
    瓒: '瓚',
    瓮: '甕',
    瓯: '甌',
    畴: '疇',
    疖: '癤',
    疟: '瘧',
    疡: '瘍',
    疬: '癧',
    疯: '瘋',
    痈: '癰',
    痉: '痙',
    痖: '瘂',
    痨: '癆',
    痪: '瘓',
    痫: '癇',
    痹: '痺',
    瘅: '癉',
    瘆: '瘮',
    瘗: '瘞',
    瘘: '瘻',
    瘪: '癟',
    瘾: '癮',
    瘿: '癭',
    癞: '癩',
    癣: '癬',
    癫: '癲',
    皲: '皸',
    盏: '盞',
    眍: '瞘',
    眬: '矓',
    睐: '睞',
    睑: '瞼',
    瞆: '瞶',
    瞩: '矚',
    矶: '礬',
    矾: '礬',
    矿: '鉱',
    砀: '碭',
    砗: '硨',
    砜: '碸',
    砵: '缽',
    砺: '礪',
    砻: '礱',
    砾: '礫',
    硖: '硤',
    硗: '磽',
    硙: '磑',
    硚: '礄',
    硷: '鹸',
    碛: '磧',
    碜: '磣',
    碱: '鹸',
    祎: '禕',
    祢: '禰',
    祯: '禎',
    秆: '稈',
    秾: '穠',
    稣: '穌',
  }),
);

/**
 * Repair simplified Chinese characters in Japanese prose.
 *
 * A Japanese model occasionally slips into the neighbouring script; each of
 * these characters has exactly one Japanese form, so replacing them is a
 * correction rather than a guess.
 *
 * @param {string} text - prose that may contain simplified forms.
 * @returns {{ text: string, repairs: { from: string, to: string, count: number }[] }}
 */
export function repairJapaneseScript(text) {
  if (typeof text !== 'string' || text === '') return { text: typeof text === 'string' ? text : '', repairs: [] };
  const counts = new Map();
  let out = '';
  for (const character of text) {
    const replacement = SIMPLIFIED_TO_JAPANESE.get(character);
    if (replacement === undefined) {
      out += character;
      continue;
    }
    counts.set(character, (counts.get(character) ?? 0) + 1);
    out += replacement;
  }
  return {
    text: out,
    repairs: [...counts.entries()].map(([from, count]) => ({ from, to: SIMPLIFIED_TO_JAPANESE.get(from), count })),
  };
}

/** Words that mark a lyric as written by a machine. */
export const CLICHE_WORDS = [
  '永遠',
  '奇跡',
  '運命',
  '絆',
  '無限',
  '絶対',
  '世界で一番',
  'ありのまま',
  '強がり',
  '夢のカケラ',
  '約束の場所',
  'キミだけ',
  '離さない',
  '泣かないで',
  'forever',
  'destiny',
  'miracle',
  'infinite',
  'never let go',
  'hold on tight',
  'broken heart',
  'shine bright',
  'world on fire',
  'unbreakable',
];

/** Characters a Japanese line may not start with (行頭禁則). */
const PROHIBITED_LINE_START = new Set([
  '、', '。', '，', '．', '・', '：', '；', '？', '！', '）', '』', '」', '】', '〕', '〉', '》', '］', '｝',
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'っ', 'ゃ', 'ゅ', 'ょ', 'ゎ', 'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ッ', 'ャ', 'ュ', 'ョ', 'ヮ', 'ヵ', 'ヶ',
  'ー', '…', '‥', 'ゝ', 'ゞ', '々',
]);

/** Small kana that attach to the mora before them. */
const SMALL_KANA = new Set([
  'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ', 'ゃ', 'ゅ', 'ょ', 'ゎ', 'ゕ', 'ゖ',
  'ァ', 'ィ', 'ゥ', 'ェ', 'ォ', 'ャ', 'ュ', 'ョ', 'ヮ', 'ヵ', 'ヶ',
]);

/** Moraic characters that count as one mora on their own. */
const MORAIC_ALONE = new Set(['っ', 'ッ', 'ん', 'ン', 'ー', 'ｰ']);

/** Vowel of each kana, used for rhyme keys. */
const KANA_VOWEL = new Map(Object.entries({
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'a', き: 'i', く: 'u', け: 'e', こ: 'o',
  さ: 'a', し: 'i', す: 'u', せ: 'e', そ: 'o',
  た: 'a', ち: 'i', つ: 'u', て: 'e', と: 'o',
  な: 'a', に: 'i', ぬ: 'u', ね: 'e', の: 'o',
  は: 'a', ひ: 'i', ふ: 'u', へ: 'e', ほ: 'o',
  ま: 'a', み: 'i', む: 'u', め: 'e', も: 'o',
  や: 'a', ゆ: 'u', よ: 'o',
  ら: 'a', り: 'i', る: 'u', れ: 'e', ろ: 'o',
  わ: 'a', を: 'o', ゐ: 'i', ゑ: 'e',
  が: 'a', ぎ: 'i', ぐ: 'u', げ: 'e', ご: 'o',
  ざ: 'a', じ: 'i', ず: 'u', ぜ: 'e', ぞ: 'o',
  だ: 'a', ぢ: 'i', づ: 'u', で: 'e', ど: 'o',
  ば: 'a', び: 'i', ぶ: 'u', べ: 'e', ぼ: 'o',
  ぱ: 'a', ぴ: 'i', ぷ: 'u', ぺ: 'e', ぽ: 'o',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'a', ゅ: 'u', ょ: 'o', ゎ: 'a', ゔ: 'u',
}));

/** Katakana to hiragana, so one table serves both scripts. */
function toHiragana(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : character;
  }
  return out;
}

/** True for a kana character (hiragana or katakana). */
function isKana(character) {
  const code = character.codePointAt(0);
  return (code >= 0x3041 && code <= 0x30ff) || code === 0x30fc;
}

/**
 * Count morae in Japanese text.
 *
 * Small kana attach to the preceding mora, `っ`, `ん` and `ー` each count one,
 * and a run of Latin letters is counted by `syllableCount` instead.
 *
 * @param {string} text - one line of Japanese (katakana is accepted).
 * @returns {number} the mora count.
 */
export function moraCount(text) {
  if (typeof text !== 'string') return 0;
  const hiragana = toHiragana(text);
  let total = 0;
  let latin = '';
  let previousVowel = '';
  const flushLatin = () => {
    if (latin !== '') total += syllableCount(latin);
    latin = '';
  };
  for (const character of hiragana) {
    if (/[A-Za-z]/.test(character)) {
      latin += character;
      continue;
    }
    flushLatin();
    if (isKana(character)) {
      if (SMALL_KANA.has(character) || SMALL_KANA.has(toKatakana(character))) {
        // Attaches to the mora before it: no extra count.
        const vowel = KANA_VOWEL.get(character);
        if (vowel !== undefined) previousVowel = vowel;
        continue;
      }
      if (character === 'ー' || character === 'ｰ') {
        total += 1;
        continue;
      }
      total += 1;
      const vowel = KANA_VOWEL.get(character);
      if (vowel !== undefined) previousVowel = vowel;
      if (MORAIC_ALONE.has(character)) previousVowel = character === 'っ' || character === 'ッ' ? 'Q' : 'N';
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(character)) {
      // Kanji carry no reading here, so count one mora per character: it keeps
      // the count monotonic and never overstates a line.
      total += 1;
    }
  }
  flushLatin();
  return total;
}

/** Hiragana to katakana, for the small-kana table above. */
function toKatakana(text) {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0);
    out += code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : character;
  }
  return out;
}

/**
 * Estimate syllables in English text by counting vowel groups.
 *
 * @param {string} text - any English fragment.
 * @returns {number} the syllable estimate, at least one per word.
 */
export function syllableCount(text) {
  if (typeof text !== 'string') return 0;
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  let total = 0;
  for (const word of words) {
    total += syllablesInWord(word);
  }
  return total;
}

/** Syllables in one lowercase English word. */
function syllablesInWord(word) {
  const cleaned = word.replace(/[^a-z]/g, '');
  if (cleaned === '') return 0;
  if (cleaned.length <= 3) return 1;
  const groups = cleaned.match(/[aeiouy]+/g);
  let count = groups === null ? 1 : groups.length;
  // Silent final "e" (but not "le" after a consonant, as in "table").
  if (cleaned.endsWith('e') && !/[aeiouy]e$/.test(cleaned.slice(0, -1)) && !/le$/.test(cleaned)) count -= 1;
  // "-ed" only sounds like a syllable after t or d.
  if (cleaned.endsWith('ed') && !/[td]ed$/.test(cleaned) && cleaned.length > 4) count -= 1;
  return Math.max(1, count);
}

/**
 * Rhyme key for one line.
 *
 * Japanese uses the vowel sequence of the last three morae; English uses the
 * final stressed vowel and whatever consonants follow it.
 *
 * @param {string} line - one lyric line.
 * @param {string} language - `ja` or `en`.
 * @returns {string} a comparable key.
 */
export function rhymeKey(line, language = 'ja') {
  const text = typeof line === 'string' ? line.trim() : '';
  if (text === '') return '';
  if (language === 'en') {
    const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
    const last = words[words.length - 1] ?? '';
    let cleaned = last.replace(/[^a-z]/g, '');
    if (cleaned === '') return '';
    // A silent final "e" never rhymes: "home" rhymes with "roam", not "me".
    if (cleaned.length > 2 && cleaned.endsWith('e') && !/le$/u.test(cleaned)) cleaned = cleaned.slice(0, -1);
    // Collapse the spellings of one sound onto one symbol, so "roam" and
    // "home" agree without a pronunciation dictionary.
    cleaned = cleaned
      .replace(/igh/u, 'i')
      .replace(/oo/u, 'u')
      .replace(/ee/u, 'i')
      .replace(/ea/u, 'i')
      .replace(/ou/u, 'u')
      .replace(/oa/u, 'o')
      .replace(/ai|ay/u, 'e')
      .replace(/ow/u, 'o')
      .replace(/ey/u, 'e');
    const match = cleaned.match(/[aeiouy][^aeiouy]*$/u);
    return match === null ? cleaned.slice(-2) : match[0];
  }
  const hiragana = toHiragana(text);
  const vowels = [];
  let previous = '';
  for (const character of hiragana) {
    if (!isKana(character)) continue;
    if (character === 'ー' || character === 'ｰ') {
      if (previous !== '') vowels.push(previous);
      continue;
    }
    if (character === 'っ') {
      vowels.push('Q');
      previous = 'Q';
      continue;
    }
    if (character === 'ん') {
      vowels.push('N');
      previous = 'N';
      continue;
    }
    const vowel = KANA_VOWEL.get(character);
    if (vowel === undefined) continue;
    if (!SMALL_KANA.has(character)) vowels.push(vowel);
    previous = vowel;
  }
  return vowels.slice(-3).join('');
}

/**
 * Split tagged lyrics into sections.
 *
 * @param {string} text - lyrics carrying `[Verse 1]`-style tags.
 * @returns {{ tag: string, lines: string[] }[]}
 */
export function parseLyricsSections(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const sections = [];
  let current = { tag: '', lines: [] };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const tag = /^\[(?<tag>[^\]]+)\]$/u.exec(line)?.groups?.tag;
    if (tag !== undefined) {
      if (current.tag !== '' || current.lines.length > 0) sections.push(current);
      current = { tag: tag.trim(), lines: [] };
      continue;
    }
    if (line === '') continue;
    current.lines.push(line);
  }
  if (current.tag !== '' || current.lines.length > 0) sections.push(current);
  return sections;
}

/** The chorus-like sections of a lyric. */
function isChorusTag(tag) {
  return /chorus|サビ|hook|drop/iu.test(tag);
}

/**
 * Inspect a lyric against the brief it was written for.
 *
 * @param {string} text - the lyric.
 * @param {object} options - `language`, `syllablesPerLine`, `rhyme`, `hook`.
 * @returns {object} sections, per-line counts, rhyme groups and warnings.
 */
export function analyzeLyrics(text, options = {}) {
  const language = resolveLanguage(options.language);
  const sections = parseLyricsSections(text);
  const warnings = [];
  const morae = [];
  const rhymeGroups = new Map();
  const budget = Number.isFinite(Number(options.syllablesPerLine)) ? Number(options.syllablesPerLine) : undefined;
  const wanted = typeof options.hook === 'string' ? options.hook.trim() : '';
  // A kana reading counts morae exactly; the written line does not, because a
  // kanji can carry any number of them. Readings are aligned by line order.
  const readings = Array.isArray(options.readings) ? options.readings : [];
  let lineIndex = 0;
  for (const section of sections) {
    for (const line of section.lines) {
      lineIndex += 1;
      const reading = typeof readings[lineIndex - 1] === 'string' ? readings[lineIndex - 1].trim() : '';
      const source = language === 'ja' && reading !== '' ? reading : line;
      const count = language === 'en' ? syllableCount(source) : moraCount(source);
      const key = rhymeKey(source, language);
      const entry = { index: lineIndex, section: section.tag, text: line, count, rhyme: key, measuredBy: source === line ? 'text' : 'reading' };
      // A missing reading must be absent, not `undefined`: the tool result has
      // to stay lossless JSON.
      if (reading !== '') entry.reading = reading;
      morae.push(entry);
      if (key !== '') {
        const bucket = rhymeGroups.get(key) ?? [];
        bucket.push(lineIndex);
        rhymeGroups.set(key, bucket);
      }
      if (budget !== undefined && Math.abs(count - budget) > 1) {
        warnings.push(`行 ${lineIndex} は ${count} ${language === 'en' ? '音節' : 'モーラ'}で、予算 ${budget} から外れています: 「${line}」`);
      }
      for (const cliche of CLICHE_WORDS) {
        if (line.toLowerCase().includes(cliche.toLowerCase())) {
          warnings.push(`行 ${lineIndex} に陳腐な語「${cliche}」があります`);
        }
      }
    }
  }
  const rhyming = [...rhymeGroups.values()].filter((lines) => lines.length > 1);
  if (language === 'ja' && readings.length === 0 && lineIndex > 0) {
    warnings.push('読み仮名が無いため、モーラ数は漢字 1 文字 = 1 モーラの概算です。正確に数えるには YOMI を付けてください。');
  }
  if (options.rhyme === 'tight' && rhyming.length === 0 && lineIndex >= 4) {
    warnings.push('韻を踏んでいる行がありません (rhyme: tight)');
  }
  const hookFound = wanted === '' ? true : text.includes(wanted);
  let hookPosition = null;
  if (wanted !== '' && hookFound) {
    for (const section of sections) {
      const at = section.lines.findIndex((line) => line.includes(wanted));
      if (at === -1) continue;
      hookPosition = isChorusTag(section.tag) && at === 0 ? 'chorus-first' : 'elsewhere';
      break;
    }
    if (hookPosition !== 'chorus-first') {
      warnings.push('フックがサビの 1 行目にありません');
    }
  }
  if (wanted !== '' && !hookFound) warnings.push(`フック「${wanted}」が歌詞にありません`);
  return {
    sections,
    lineCount: lineIndex,
    morae,
    rhymes: [...rhymeGroups.entries()].map(([key, lines]) => ({ key, lines })),
    hookFound,
    hookPosition,
    warnings,
  };
}

/** Normalise a language option. */
export function resolveLanguage(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'ja' || text === 'jp' || text === 'japanese') return 'ja';
  if (text === 'en' || text === 'english') return 'en';
  return 'ja';
}

/**
 * Apply Japanese typesetting rules to generated prose.
 *
 * Idempotent: running it twice returns the same text.
 *
 * @param {string} text - prose straight from a model.
 * @returns {string} the same prose, typeset.
 */
export function normalizeJapaneseTypography(text) {
  if (typeof text !== 'string') return '';
  let out = text.replace(/\r\n?/gu, '\n');
  // Ellipses and dashes have one correct form in Japanese typesetting.
  out = out.replace(/…+/gu, '……').replace(/\.{2,}/gu, '……');
  out = out.replace(/[—―]{1,}/gu, '——').replace(/-{2,}/gu, '——');
  // Full-width exclamation and question marks, with the space that follows them.
  out = out.replace(/[!！]/gu, '！').replace(/[?？]/gu, '？');
  out = out.replace(/([！？]+)[ \t]+/gu, '$1\u3000');
  out = out.replace(/([！？]+)(?![！？\s」』）\n])/gu, '$1\u3000');
  out = out.replace(/！？/gu, '！？');
  // Collapse runs of blank lines and trim trailing spaces.
  out = out.split('\n').map((line) => line.replace(/[ \t\u3000]+$/u, '')).join('\n');
  out = out.replace(/\n{3,}/gu, '\n\n');
  // 行頭禁則 first, while every line is still flush: a prohibited character
  // hangs onto the line above rather than starting its own.
  out = hangProhibitedLineStarts(out);
  // Paragraph indent: every content line starts one full-width space in.
  out = out
    .split('\n')
    .map((line) => {
      if (line === '') return line;
      if (line.startsWith('\u3000')) return line;
      if (/^[#>*|\-+]/u.test(line) || /^\d+\./u.test(line)) return line;
      return `\u3000${line}`;
    })
    .join('\n');
  return out;
}

/** Move a prohibited first character onto the previous line. */
function hangProhibitedLineStarts(text) {
  const lines = text.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '' || lines[index - 1] === '') continue;
    if (!PROHIBITED_LINE_START.has(line[0])) continue;
    lines[index - 1] += line[0];
    lines[index] = line.slice(1);
  }
  return lines.join('\n');
}

/**
 * Pull the first balanced JSON value out of model output.
 *
 * @param {string} text - output that may wrap JSON in prose or a code fence.
 * @returns {unknown} the parsed value, or `undefined` when there is none.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return undefined;
  const fenced = /```(?:json)?\s*\n?(?<body>[\s\S]*?)```/u.exec(text)?.groups?.body;
  const candidate = fenced !== undefined ? fenced : text;
  for (let start = 0; start < candidate.length; start += 1) {
    const opening = candidate[start];
    if (opening !== '{' && opening !== '[') continue;
    const end = matchBracket(candidate, start);
    if (end === -1) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // Not JSON after all; keep scanning.
    }
  }
  return undefined;
}

/** Index of the bracket that closes the one at `start`, or -1. */
function matchBracket(text, start) {
  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Pitch name for a MIDI note number. */
export function midiToName(midi) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const value = Math.round(Number(midi));
  const octave = Math.floor(value / 12) - 1;
  return `${names[((value % 12) + 12) % 12]}${octave}`;
}

/** Major scale offsets from the tonic. */
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

/** Semitone offset of a key name, so a lyric can be sketched in any key. */
const KEY_OFFSETS = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

/**
 * Turn lyric lines into an MSX score a singer could follow.
 *
 * One note per mora, one phrase per line, an I–V–vi–IV bass underneath. The
 * result is valid input for `generate_music`.
 *
 * @param {object} input - `lines`, `key`, `tempo`, `meter`, `seed`.
 * @returns {string} MSX score text.
 */
export function composeMelodySketch(input = {}) {
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  const key = typeof input.key === 'string' && KEY_OFFSETS[input.key] !== undefined ? input.key : 'C';
  const tonic = 60 + KEY_OFFSETS[key];
  const tempo = Number.isFinite(Number(input.tempo)) ? Math.min(240, Math.max(40, Math.round(Number(input.tempo)))) : 120;
  const meter = typeof input.meter === 'string' && /^\d+\/4$/u.test(input.meter) ? input.meter : '4/4';
  const beatsPerBar = Number(meter.split('/')[0]) || 4;
  const seed = Number.isFinite(Number(input.seed)) ? Math.trunc(Number(input.seed)) : 1;
  let state = (seed * 2654435761) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const lines = rawLines.map((line) => {
    if (typeof line === 'string') return { text: line, morae: moraCount(line) };
    const text = typeof line?.text === 'string' ? line.text : '';
    const morae = Number.isFinite(Number(line?.morae)) ? Number(line.morae) : moraCount(text);
    return { text, morae };
  });
  const melody = [];
  const bass = [];
  let cursor = 0;
  const degreePool = [0, 1, 2, 4, 5, 7, 9];
  lines.forEach((line, lineIndex) => {
    const morae = Math.max(1, Math.min(32, line.morae));
    const noteBeats = 0.5;
    const lineBeats = morae * noteBeats;
    const bars = Math.max(1, Math.ceil(lineBeats / beatsPerBar));
    const lineStart = cursor;
    // Melody: a small random walk over the pentatonic degrees, resolving down
    // onto the tonic on the last note of each phrase.
    let degree = 4 + Math.floor(next() * 3);
    for (let index = 0; index < morae; index += 1) {
      if (index === morae - 1) degree = lineIndex % 2 === 0 ? 7 : 5;
      else degree += Math.round(next() * 4 - 2);
      degree = Math.max(0, Math.min(degreePool.length - 1, degree));
      // Melody sits an octave above the tonic; the bass takes the octave below.
      const pitch = tonic + 12 + degreePool[degree];
      const start = lineStart + index * noteBeats;
      const duration = index === morae - 1 ? 1 : noteBeats;
      melody.push(`${midiToName(pitch)} ${round(start)} ${round(duration)}`);
    }
    // Bass: I–V–vi–IV under each bar.
    const progression = [0, 7, 9, 5];
    for (let bar = 0; bar < bars; bar += 1) {
      const root = progression[(Math.floor(lineStart / beatsPerBar) + bar) % progression.length];
      const start = lineStart + bar * beatsPerBar;
      bass.push(`${midiToName(tonic - 12 + root)} ${round(start)} ${round(beatsPerBar)}`);
    }
    cursor = lineStart + bars * beatsPerBar;
  });
  const header = [`title Melody sketch (${key})`, `tempo ${tempo}`, 'track melody', 'instrument gm:73', ...melody, 'track bass', 'instrument gm:33', ...bass];
  return header.join('\n');
}

/** Round beats to the nearest sixteenth, without trailing noise. */
function round(value) {
  return Math.round(value * 4) / 4;
}

/**
 * Reading time in minutes for one body of text.
 *
 * @param {string} text - the body.
 * @param {string} language - `ja` or `en`.
 * @returns {number} whole minutes, at least one.
 */
export function readingTime(text, language = 'ja') {
  if (typeof text !== 'string') return 0;
  if (resolveLanguage(language) === 'en') {
    const words = text.trim().split(/\s+/u).filter((word) => word !== '').length;
    return Math.max(1, Math.ceil(words / 220));
  }
  const characters = (text.match(/[\u3040-\u30ff\u4e00-\u9fff]/gu) ?? []).length;
  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/u).length;
  return Math.max(1, Math.ceil((characters + words * 2) / 400));
}

// ---------------------------------------------------------------------------
// LLM bridge
// ---------------------------------------------------------------------------

/**
 * Resolve the model route a writing tool should use.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} options - resolved plugin options (`options.writing`).
 * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string }>}
 */
export async function resolveWritingRoute(ctx, options = {}) {
  const writing = options.writing ?? {};
  const provider = typeof writing.provider === 'string' ? writing.provider.trim() : '';
  const model = typeof writing.model === 'string' ? writing.model.trim() : '';
  if (provider !== '' && model !== '') return { provider, model };
  const selection = ctx?.get?.('agentDefaultModel')?.currentSelection?.();
  if (selection?.provider !== undefined && selection?.model !== undefined) {
    const route = { provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort !== undefined) route.reasoningEffort = selection.reasoningEffort;
    return route;
  }
  throw new Error(
    '文章生成に使うモデルが決まっていません。cordis.patch.yml の media-studio 行で writing.provider と writing.model を指定するか、既定のモデルを設定してください。No model route is available for the writing tools.',
  );
}

/**
 * Run one non-streaming model call and return the concatenated text.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} route - `provider`, `model`, optional `reasoningEffort`.
 * @param {object} request - `system`, `messages`, `maxTokens`, `temperature`,
 *   `timeoutMs`, `signal`.
 * @returns {Promise<{ text: string, usage: object|undefined, finish: object|undefined }>}
 */
export async function generateText(ctx, route, request = {}) {
  const llm = ctx?.get?.('llm');
  if (llm === undefined) {
    throw new Error(
      'このハーネスに llm サービスがありません。文章生成ツールは llm サービスが必要です。The writing tools require the llm service.',
    );
  }
  const maxTokens = Number.isFinite(Number(request.maxTokens)) ? Math.max(64, Math.trunc(Number(request.maxTokens))) : 4096;
  const timeoutMs = Number.isFinite(Number(request.timeoutMs)) ? Math.max(1000, Math.trunc(Number(request.timeoutMs))) : 120000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const forward = () => controller.abort(request.signal?.reason);
  if (request.signal !== undefined) {
    if (request.signal.aborted) forward();
    else request.signal.addEventListener('abort', forward, { once: true });
  }
  const base = {
    provider: route.provider,
    model: route.model,
    messages: request.messages ?? [],
    system: request.system,
    maxTokens,
    temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : undefined,
    signal: controller.signal,
  };
  // The adapter refuses a dispatch whose controls differ from the prepared
  // ones, so every prepared control has to travel with the request.
  if (route.reasoningEffort !== undefined) base.reasoningEffort = route.reasoningEffort;
  // Some provider adapters route nested calls by the session that asked for
  // them (the opencode adapter sends it as a request header).
  if (request.sessionId !== undefined) base.sessionId = request.sessionId;
  try {
    const prepared = await prepareRoute(llm, route, { maxTokens, temperature: base.temperature, signal: controller.signal });
    // Dispatch exactly the controls the adapter prepared: a differing control
    // is rejected before the request leaves the process.
    const controls = prepared.config ?? {};
    const dispatch = {
      ...base,
      provider: controls.provider ?? base.provider,
      model: controls.model ?? base.model,
      maxTokens: controls.maxTokens ?? base.maxTokens,
      temperature: controls.temperature,
    };
    if (controls.reasoningEffort !== undefined) dispatch.reasoningEffort = controls.reasoningEffort;
    else delete dispatch.reasoningEffort;
    if (dispatch.temperature === undefined) delete dispatch.temperature;
    let text = '';
    let usage;
    let finish;
    for await (const chunk of prepared.stream(dispatch)) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'usage') usage = chunk.usage;
      else if (chunk.type === 'finish') finish = chunk.reason;
    }
    const kind = finish?.kind ?? 'stop';
    if (kind === 'error') {
      throw new Error(`モデルの呼び出しに失敗しました: ${finish?.failure?.message ?? '不明なエラー'}。The model call failed.`);
    }
    if (kind === 'aborted') {
      throw new Error('モデルの呼び出しが中断されました。The model call was aborted.');
    }
    if (kind === 'max-tokens') {
      throw new Error(`出力が上限 (${maxTokens} トークン) に達しました。maxTokens を増やしてください。The reply hit the token ceiling.`);
    }
    if (text.trim() === '') throw new Error('モデルが空の応答を返しました。The model returned no text.');
    return { text, usage, finish };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener?.('abort', forward);
  }
}

/** Ask the llm service for a prepared call, with a plain-stream fallback. */
async function prepareRoute(llm, route, controls) {
  const config = { provider: route.provider, model: route.model, maxTokens: controls.maxTokens };
  if (route.reasoningEffort !== undefined) config.reasoningEffort = route.reasoningEffort;
  if (controls.temperature !== undefined) config.temperature = controls.temperature;
  if (typeof llm.prepareCall === 'function') {
    const prepared = await llm.prepareCall(config, controls.signal);
    return { stream: (options) => prepared.stream(options), config: prepared.config };
  }
  return { stream: (options) => llm.stream(options), config: config };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/** Wrap one instruction as a user message. */
function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** Join non-empty lines, keeping the prompt readable. */
function block(lines) {
  return lines.filter((line) => typeof line === 'string' && line !== '').join('\n');
}

/** The section list for a structure name or a comma-separated custom list. */
export function resolveStructure(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return LYRIC_STRUCTURES['jpop-standard'];
  if (LYRIC_STRUCTURES[text] !== undefined) return LYRIC_STRUCTURES[text];
  const custom = text.split(/[,>]/u).map((part) => part.trim()).filter((part) => part !== '');
  return custom.length > 0 ? custom : LYRIC_STRUCTURES['jpop-standard'];
}

/**
 * Prompt for `write_lyrics`.
 *
 * @param {object} input - the tool arguments.
 * @returns {{ system: string, messages: object[] }}
 */
export function buildLyricsPrompt(input = {}) {
  const language = resolveLanguage(input.language);
  const structure = resolveStructure(input.structure);
  const budget = Number.isFinite(Number(input.syllablesPerLine)) ? Math.trunc(Number(input.syllablesPerLine)) : undefined;
  const banned = [...CLICHE_WORDS, ...(Array.isArray(input.bannedWords) ? input.bannedWords : [])];
  const system = block([
    'You are a professional lyricist with a decade of chart credits, writing for a living singer rather than for a page.',
    `Write in ${language === 'en' ? 'English' : 'Japanese'}.`,
    'Non-negotiable craft rules:',
    '1. One concrete central image carries the whole song. It must be something a camera could photograph, not an abstraction.',
    '2. Verse 1 sets the scene in the present tense; the chorus says what the scene means. The pre-chorus must tighten, not summarise.',
    '3. The hook is a short phrase a stranger could repeat after one listen. It opens the chorus and returns verbatim in the final line of the last chorus.',
    '4. Write the way people actually speak under pressure: short clauses, plain words, no inverted syntax to force a rhyme.',
    '5. Never use these words or phrases: ' + banned.join(', ') + '.',
    budget === undefined
      ? '6. Keep every line between 8 and 14 morae (Japanese) or 6 and 12 syllables (English) so a melody has room to breathe.'
      : `6. Keep every line at ${budget} morae (Japanese) or syllables (English), plus or minus one.`,
    '7. Rhyme by vowel colour, not by spelling. A slant rhyme that sounds natural beats a perfect rhyme that sounds forced.',
    `8. Follow this section order exactly: ${structure.join(' / ')}.`,
    '',
    'Return exactly this, with no preamble and no commentary:',
    '1. The lyric, with each section tag on its own line in square brackets, for example [Verse 1].',
    '2. A line containing only three hyphens: ---',
    '3. One line starting with "HOOK:" followed by the hook line verbatim.',
    '4. One line starting with "IMAGE:" followed by the central image in a few words.',
    language === 'ja'
      ? '5. A line containing only "YOMI:", then one line of hiragana for each lyric line above, in the same order, nothing else. Count the morae of each reading before you answer: small kana ゃゅょ attach to the mora before them, っ ん ー each count one. Rewrite any line that misses the budget.'
      : '5. Before answering, count the syllables of every line and rewrite any line that misses the budget.',
  ]);
  const brief = {
    brief: input.brief,
    genre: input.genre ?? 'jpop',
    mood: input.mood,
    perspective: input.perspective,
    rhyme: input.rhyme ?? 'loose',
    structure,
    language,
    syllablesPerLine: budget,
    hook: input.hook,
    tempo: input.tempo,
    meter: input.meter,
    length: input.length ?? 'standard',
  };
  return {
    system,
    messages: [userMessage(`Write the lyric for this brief:\n${JSON.stringify(brief, null, 2)}`)],
  };
}

/**
 * Prompt for the story bible that `write_novel` starts from.
 *
 * @param {object} input - the tool arguments.
 * @returns {{ system: string, messages: object[] }}
 */
export function buildOutlinePrompt(input = {}) {
  const language = resolveLanguage(input.language);
  const system = block([
    'You are a published novelist and story editor building a story bible before drafting.',
    `Write in ${language === 'en' ? 'English' : 'Japanese'}.`,
    'A usable bible answers the questions a writer gets stuck on at chapter nine: what does each character want, what do they refuse to admit, what is the clock, and what does the reader know that the protagonist does not.',
    'Every beat must change the situation. "Character learns about the world" is not a beat; "character lies to the one person who could help" is.',
    'Return strict JSON only, with no prose and no code fence, matching this shape:',
    '{"logline":string,"theme":string,"characters":[{"name":string,"role":string,"want":string,"wound":string,"secret":string,"arc":string}],"setting":string,"timeline":[string],"beats":[{"act":string,"beat":string,"summary":string}],"foreshadowing":[string]}',
    'Size limits, which matter more than exhaustiveness: every string at most 60 characters; 3 to 6 characters; 6 to 8 timeline entries; 10 to 14 beats; 3 to 5 foreshadowing items. The whole reply must stay under 1200 words.',
  ]);
  const brief = {
    brief: input.brief,
    genre: input.genre,
    pov: input.pov ?? 'third-limited',
    tense: input.tense ?? 'past',
    style: input.style,
    targetLength: input.targetLength,
    rating: input.rating,
    language,
  };
  return { system, messages: [userMessage(`Build the story bible for this brief:\n${JSON.stringify(brief, null, 2)}`)] };
}

/**
 * Prompt for `write_novel`.
 *
 * @param {object} input - the tool arguments.
 * @returns {{ system: string, messages: object[] }}
 */
export function buildNovelPrompt(input = {}) {
  const mode = typeof input.mode === 'string' ? input.mode : 'draft';
  if (mode === 'outline') return buildOutlinePrompt(input);
  const language = resolveLanguage(input.language);
  const targetLength = Number.isFinite(Number(input.targetLength)) ? Math.trunc(Number(input.targetLength)) : 3000;
  const system = block([
    'You are a published novelist drafting a chapter. Write the scene, not a summary of it.',
    `Write in ${language === 'en' ? 'English' : 'Japanese'}.`,
    `Point of view: ${input.pov ?? 'third-limited'}. Tense: ${input.tense ?? 'past'}. Keep both consistent for every sentence.`,
    input.style !== undefined && input.style !== '' ? `Style: ${input.style}.` : '',
    'Craft rules:',
    '1. Every scene has a goal, an obstacle, and a turn. The turn is a change in what the character believes they can do.',
    '2. Show through action and sensory detail. Name what a character notices, not what the narrator concludes.',
    '3. Dialogue carries subtext: people answer a slightly different question than the one asked, and nobody explains the plot.',
    '4. Cut any sentence that only restates the previous one. Cut any adjective the noun does not need.',
    '5. End the chapter on a hook: a decision, a discovery, or an arrival that makes stopping impossible.',
    `6. Length: about ${targetLength} characters${language === 'en' ? ' (characters, not words)' : ''}. Do not overshoot by more than 15 percent.`,
    'Return only the prose. No title, no chapter number, no notes.',
  ]);
  const context = {
    mode,
    brief: input.brief,
    genre: input.genre,
    chapterIndex: input.chapterIndex,
    outline: input.outline,
    previous: typeof input.previous === 'string' ? input.previous.slice(-6000) : undefined,
    reviseTarget: input.revise,
  };
  const instruction =
    mode === 'continue'
      ? 'Continue the scene below without repeating it. Match its rhythm and voice.'
      : mode === 'revise'
        ? 'Rewrite the passage to the requested direction, keeping the events identical.'
        : 'Write the chapter described by this brief and story bible.';
  return {
    system,
    messages: [userMessage(`${instruction}\n\nContext:\n${JSON.stringify(context, null, 2)}`)],
  };
}

/**
 * Prompt for `write_article`.
 *
 * @param {object} input - the tool arguments.
 * @returns {{ system: string, messages: object[] }}
 */
export function buildArticlePrompt(input = {}) {
  const mode = typeof input.mode === 'string' ? input.mode : 'draft';
  const language = resolveLanguage(input.language);
  const format = ARTICLE_FORMATS[input.format] ?? ARTICLE_FORMATS.column;
  const targetLength = Number.isFinite(Number(input.targetLength)) ? Math.trunc(Number(input.targetLength)) : 2000;
  const seo = mode === 'seo';
  const system = block([
    'You are a senior editor at a publication that fact-checks every claim before it runs.',
    `Write in ${language === 'en' ? 'English' : 'Japanese'}.`,
    `Format: ${input.format ?? 'column'} — ${format}.`,
    input.audience !== undefined && input.audience !== '' ? `Reader: ${input.audience}.` : '',
    input.tone !== undefined && input.tone !== '' ? `Tone: ${input.tone}.` : '',
    'Editing rules:',
    '1. Open with the fact, not with a definition, a question, or "in today\'s world". The first sentence must be worth reading on its own.',
    '2. One idea per paragraph. If a paragraph has two ideas, it is two paragraphs.',
    '3. Use numbers only when the supplied sources contain them. Never invent a statistic, a study, a date, or a quote. If a claim needs a source you were not given, mark it [要出典].',
    '4. Prefer the concrete noun and the active verb. Delete intensifiers.',
    '5. Subheads must describe their section, not decorate it.',
    seo
      ? 'Return strict JSON only, with no prose and no code fence: {"titles":[{"text":string,"characters":number}],"metaDescription":string,"slug":string,"headings":[string],"faq":[{"question":string,"answer":string}],"keywords":[string]}'
      : `Return Markdown only: a single H1, then the body with H2/H3 as needed. Length: about ${targetLength} characters; under ${Math.round(targetLength * 0.8)} is a miss and should be expanded with substance, not filler. No preamble, no notes.`,
  ]);
  const brief = {
    mode,
    topic: input.topic,
    format: input.format ?? 'column',
    audience: input.audience,
    tone: input.tone,
    keywords: input.keywords,
    sources: input.sources,
    brand: input.brand,
    cta: input.cta,
    targetLength,
    outline: input.outline,
    previous: typeof input.previous === 'string' ? input.previous.slice(-6000) : undefined,
  };
  return {
    system,
    messages: [userMessage(`${mode === 'rewrite' ? 'Rewrite this draft' : 'Write this article'} for the brief:\n${JSON.stringify(brief, null, 2)}`)],
  };
}

/** Metadata description of the engines, used in tool descriptions. */
export function describeWritingCapabilities() {
  return {
    languages: WRITING_LANGUAGES,
    genres: LYRIC_GENRES,
    structures: Object.keys(LYRIC_STRUCTURES),
    formats: Object.keys(ARTICLE_FORMATS),
    cliches: CLICHE_WORDS.length,
  };
}
