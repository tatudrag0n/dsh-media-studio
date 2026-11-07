#!/usr/bin/env python
"""Build parametric CAD solids and technical drawings inside Blender.

The host half of the plugin (`cad.js`) tessellates the part list itself and
hands this script a list of world-space triangle meshes, so both backends —
the JavaScript STL writer and Blender — work from exactly the same geometry.
This script only does what needs Blender:

- apply the boolean operations in order (EXACT solver),
- export the result as binary STL / OBJ / GLB / PLY,
- render orthographic front / top / right views and an isometric view as PNG.

Usage (from ``cad.js``)::

    blender -b --factory-startup --python cad_blender.py -- <spec.json>

``spec.json``
    {
      "mode": "solid" | "drawing",
      "solids": [
        {"operation": "union", "vertices": [[x, y, z], ...], "faces": [[i, j, k], ...]},
        {"operation": "difference", "vertices": [...], "faces": [...]}
      ],
      "format": "stl" | "obj" | "glb" | "ply",       # mode=solid
      "outputPath": "C:/.../solid.stl",               # mode=solid
      "views": ["front", "top", "right", "iso"],      # mode=drawing
      "outputDir": "C:/.../views",                    # mode=drawing
      "prefix": "view",
      "width": 1600,
      "height": 1200,
      "engine": "workbench" | "freestyle",
      "lineWidth": 1.6,
      "resultPath": "C:/.../result.json"
    }

The result is always written to ``resultPath``::

    {"ok": true, "triangles": 96, "vertices": 48,
     "bbox": {"min": [-50, -30, -3], "max": [50, 30, 3]},
     "files": [{"view": "front", "path": "...", "bytes": 51234, "width": 1600, "height": 1200}]}

or ``{"ok": false, "error": "...", "traceback": "..."}``. Coordinates are
millimetres throughout; the scene unit scale is set to millimetres too, so a
``.blend`` opened by hand agrees with the numbers.
"""

from __future__ import annotations

import json
import math
import os
import sys
import traceback

import bmesh
import bpy

# Camera rotation (XYZ Euler, degrees) for each view. The camera then sits
# opposite the view direction and looks at the centre of the model.
VIEW_ROTATIONS = {
    'front': (90.0, 0.0, 0.0),
    'top': (0.0, 0.0, 0.0),
    'right': (90.0, 0.0, 90.0),
    'iso': (54.7356, 0.0, 45.0),
}

# Which model axes span the picture, per view.
VIEW_AXES = {
    'front': (0, 2),
    'top': (0, 1),
    'right': (1, 2),
}

BOOL_OPERATIONS = {
    'union': 'UNION',
    'difference': 'DIFFERENCE',
    'intersect': 'INTERSECT',
}


# #region Spec


def read_spec() -> dict:
    """Read the spec: a JSON file path, or inline JSON, after ``--``."""
    argv = sys.argv
    separator = argv.index('--') if '--' in argv else len(argv)
    arguments = argv[separator + 1:]
    if not arguments:
        raise RuntimeError('no spec argument after --')
    argument = arguments[0]
    if argument.lstrip().startswith('{'):
        return json.loads(argument)
    with open(argument, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def write_result(path, payload: dict) -> None:
    """Write the result JSON the host half reads back."""
    if not path:
        return
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False)


# #endregion

# #region Scene


def reset_scene() -> None:
    """Start from an empty scene, whatever the user's startup file holds."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene.unit_settings.scale_length = 0.001
    scene.unit_settings.length_unit = 'MILLIMETERS'


def make_object(name: str, vertices, faces):
    """Link a triangle mesh built from plain Python lists."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(float(value) for value in point) for point in vertices], [],
                     [tuple(int(index) for index in face) for face in faces])
    mesh.validate(verbose=False)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def recalc_normals(mesh) -> None:
    """Make every face point outwards, so the EXACT boolean solver is happy."""
    element = bmesh.new()
    element.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(element, faces=element.faces)
    element.to_mesh(mesh)
    element.free()
    mesh.update()


def triangulate(obj) -> None:
    """Triangulate, so the polygon count is the triangle count."""
    element = bmesh.new()
    element.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(element, faces=element.faces)
    bmesh.ops.triangulate(element, faces=element.faces, quad_method='BEAUTY', ngon_method='BEAUTY')
    element.to_mesh(obj.data)
    element.free()
    obj.data.update()


def select_only(obj) -> None:
    """Make one object the sole selection and the active object."""
    for candidate in bpy.data.objects:
        if candidate is None:
            continue
        try:
            candidate.select_set(False)
        except RuntimeError:
            pass
    view_layer = bpy.context.view_layer
    if view_layer is not None:
        view_layer.objects.active = obj
    obj.select_set(True)


def boolean_apply(target, operand, operation: str) -> None:
    """Apply one boolean operation in place and drop the operand."""
    modifier = target.modifiers.new(name='csg', type='BOOLEAN')
    modifier.operation = operation
    modifier.object = operand
    if hasattr(modifier, 'solver'):
        modifier.solver = 'EXACT'
    if hasattr(modifier, 'use_self'):
        modifier.use_self = False
    select_only(target)
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def build_solid(solids):
    """Apply the operations in order and return the resulting object."""
    if not solids:
        raise RuntimeError('the model has no parts')
    result = None
    for index, entry in enumerate(solids):
        operation = BOOL_OPERATIONS.get(str(entry.get('operation', 'union')).lower())
        if operation is None:
            raise RuntimeError(f'unknown operation: {entry.get("operation")!r}')
        obj = make_object(f'part-{index:03d}', entry.get('vertices', []), entry.get('faces', []))
        if len(obj.data.polygons) == 0:
            raise RuntimeError(f'part {index} has no faces')
        recalc_normals(obj.data)
        if result is None:
            if operation != 'UNION':
                raise RuntimeError('the first part must be a union')
            result = obj
            continue
        select_only(result)
        boolean_apply(result, obj, operation)
        bpy.data.objects.remove(obj, do_unlink=True)
    if result is None:
        raise RuntimeError('the model is empty')
    triangulate(result)
    if len(result.data.polygons) == 0:
        raise RuntimeError('the boolean result is empty: the parts may not touch, or a cut removed everything')
    return result


def measure(obj):
    """Triangle count, vertex count and bounding box of the finished solid."""
    mesh = obj.data
    coordinates = [vertex.co for vertex in mesh.vertices]
    if not coordinates:
        return 0, 0, {'min': [0.0, 0.0, 0.0], 'max': [0.0, 0.0, 0.0]}
    minimum = [min(point[axis] for point in coordinates) for axis in range(3)]
    maximum = [max(point[axis] for point in coordinates) for axis in range(3)]
    return len(mesh.polygons), len(mesh.vertices), {'min': minimum, 'max': maximum}


# #endregion

# #region Export


def try_operator(operator, variants) -> None:
    """Call an operator with the first set of arguments it accepts.

    Export operator signatures move between Blender versions; trying a couple
    of spellings is cheaper than pinning this script to one release.
    """
    last = None
    for arguments in variants:
        try:
            operator(**arguments)
            return
        except TypeError as cause:  # unsupported keyword
            last = cause
        except RuntimeError as cause:  # operator ran and failed
            last = cause
            break
    raise RuntimeError(f'export failed: {last}')


def export_solid(obj, fmt: str, path: str) -> None:
    """Write the solid in one mesh format."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    select_only(obj)
    if fmt == 'stl':
        try_operator(bpy.ops.wm.stl_export, [
            {'filepath': path, 'export_selected_objects': True, 'ascii_format': False,
             'apply_modifiers': True, 'global_scale': 1.0},
            {'filepath': path, 'export_selected_objects': True, 'ascii_format': False},
            {'filepath': path, 'ascii_format': False},
            {'filepath': path},
        ])
    elif fmt == 'obj':
        try_operator(bpy.ops.wm.obj_export, [
            {'filepath': path, 'export_selected_objects': True, 'apply_modifiers': True},
            {'filepath': path, 'export_selected_objects': True},
            {'filepath': path, 'use_selection': True},
            {'filepath': path},
        ])
    elif fmt == 'glb':
        try_operator(bpy.ops.export_scene.gltf, [
            {'filepath': path, 'export_format': 'GLB', 'use_selection': True, 'export_apply': True},
            {'filepath': path, 'export_format': 'GLB', 'use_selection': True},
            {'filepath': path, 'export_format': 'GLB'},
        ])
    elif fmt == 'ply':
        try_operator(bpy.ops.wm.ply_export, [
            {'filepath': path, 'export_selected_objects': True, 'apply_modifiers': True},
            {'filepath': path, 'export_selected_objects': True},
            {'filepath': path},
        ])
    else:
        raise RuntimeError(f'unsupported format: {fmt}')
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise RuntimeError(f'{fmt} export wrote nothing to {path}')


# #endregion

# #region Render


def white_world(scene) -> None:
    """A white background, so the PNG looks like a drawing sheet."""
    world = bpy.data.worlds.new('cad-paper')
    world.use_nodes = True
    background = world.node_tree.nodes.get('Background')
    if background is not None:
        background.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
        background.inputs[1].default_value = 1.0
    scene.world = world


def paper_material(obj) -> None:
    """A near-white material, so the outlines carry the drawing."""
    material = bpy.data.materials.new('cad-paper')
    material.use_nodes = True
    tree = material.node_tree
    principled = tree.nodes.get('Principled BSDF')
    if principled is not None:
        principled.inputs['Base Color'].default_value = (0.97, 0.97, 0.98, 1.0)
        if 'Roughness' in principled.inputs:
            principled.inputs['Roughness'].default_value = 1.0
    obj.data.materials.append(material)


def setup_workbench(scene) -> None:
    """Workbench: shaded faces with cavity lines, white paper."""
    scene.render.engine = 'BLENDER_WORKBENCH'
    white_world(scene)
    shading = scene.display.shading
    shading.light = 'STUDIO'
    shading.color_type = 'SINGLE'
    shading.single_color = (0.82, 0.84, 0.88)
    shading.show_cavity = True
    shading.cavity_type = 'BOTH'
    shading.curvature_ridge_factor = 1.0
    shading.curvature_valley_factor = 1.0
    shading.show_object_outline = True
    shading.object_outline_color = (0.12, 0.13, 0.16)
    shading.background_type = 'VIEWPORT'
    shading.background_color = (1.0, 1.0, 1.0)
    shading.show_shadows = False
    scene.display.render_aa = '16'


def setup_freestyle(scene, line_width: float) -> None:
    """Freestyle over EEVEE: pure line art on white."""
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.use_freestyle = True
    scene.render.line_thickness = line_width
    scene.view_layers[0].use_freestyle = True
    white_world(scene)
    settings = scene.view_layers[0].freestyle_settings
    try:
        if len(settings.linesets) == 0:
            bpy.ops.scene.freestyle_lineset_add()
        lineset = settings.linesets[0]
        # A fresh lineset carries no linestyle at all in Blender 5.x.
        if lineset.linestyle is None:
            lineset.linestyle = bpy.data.linestyles.new('cad-lines')
        lineset.linestyle.color = (0.0, 0.0, 0.0)
        lineset.linestyle.thickness = line_width * 1.6
        # Blender 5 renamed the select_* switches to exclude_*; set whichever
        # this build has so silhouettes, borders and creases all get a line.
        for name in ('exclude_silhouette', 'exclude_border', 'exclude_crease',
                     'exclude_contour', 'exclude_external_contour', 'exclude_material_boundary'):
            if hasattr(lineset, name):
                setattr(lineset, name, False)
        for name in ('select_silhouette', 'select_border', 'select_crease'):
            if hasattr(lineset, name):
                setattr(lineset, name, True)
    except Exception:  # noqa: BLE001 - a missing lineset still renders the shape
        pass


def camera_direction(rotation) -> tuple:
    """World-space viewing direction for an XYZ Euler camera rotation."""
    rx = math.radians(rotation[0])
    rz = math.radians(rotation[2])
    return (
        -math.sin(rz) * math.sin(rx),
        math.cos(rz) * math.sin(rx),
        -math.cos(rx),
    )


def view_extent(bbox, view: str) -> tuple:
    """Width and height of the model on the picture plane of one view."""
    minimum = bbox['min']
    maximum = bbox['max']
    size = [maximum[axis] - minimum[axis] for axis in range(3)]
    if view == 'iso':
        diagonal = math.sqrt(size[0] ** 2 + size[1] ** 2 + size[2] ** 2)
        return diagonal * 0.78, diagonal * 0.78
    horizontal, vertical = VIEW_AXES[view]
    return max(size[horizontal], 1e-6), max(size[vertical], 1e-6)


def ortho_scale_for(width: float, height: float, resolution_x: int, resolution_y: int, margin: float = 1.18) -> float:
    """Ortho scale that fits `width` × `height` into the render frame."""
    if resolution_x >= resolution_y:
        needed = max(width, height * resolution_x / resolution_y)
    else:
        needed = max(width * resolution_y / resolution_x, height)
    return max(needed * margin, 1e-3)


def render_views(obj, spec: dict, bbox: dict):
    """Render the requested views and describe the PNG files."""
    scene = bpy.context.scene
    width = int(spec.get('width') or 1600)
    height = int(spec.get('height') or 1200)
    engine = str(spec.get('engine') or 'workbench').lower()
    line_width = float(spec.get('lineWidth') or 1.6)
    prefix = str(spec.get('prefix') or 'view')
    output_dir = str(spec.get('outputDir') or '.')
    views = [view for view in (spec.get('views') or ['front', 'top', 'right', 'iso'])
             if view in VIEW_ROTATIONS]
    if not views:
        views = ['front', 'top', 'right', 'iso']
    os.makedirs(output_dir, exist_ok=True)

    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGB'
    # AgX (the 4.x / 5.x default) turns white into light grey, which makes a
    # drawing sheet look dirty. Standard keeps the paper white.
    try:
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
    except Exception:  # noqa: BLE001 - the default transform is still usable
        pass
    if engine == 'freestyle':
        setup_freestyle(scene, line_width)
        paper_material(obj)
    else:
        setup_workbench(scene)

    camera_data = bpy.data.cameras.new('cad-camera')
    camera_data.type = 'ORTHO'
    camera = bpy.data.objects.new('cad-camera', camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    centre = [(bbox['min'][axis] + bbox['max'][axis]) / 2 for axis in range(3)]
    size = [bbox['max'][axis] - bbox['min'][axis] for axis in range(3)]
    distance = max(math.sqrt(sum(value ** 2 for value in size)) * 2.5, 50.0)
    camera_data.clip_start = 0.01
    camera_data.clip_end = distance * 40

    files = []
    for view in views:
        rotation = VIEW_ROTATIONS[view]
        direction = camera_direction(rotation)
        camera.location = (
            centre[0] - direction[0] * distance,
            centre[1] - direction[1] * distance,
            centre[2] - direction[2] * distance,
        )
        camera.rotation_euler = tuple(math.radians(value) for value in rotation)
        extent_width, extent_height = view_extent(bbox, view)
        camera_data.ortho_scale = ortho_scale_for(extent_width, extent_height, width, height)
        target = os.path.join(output_dir, f'{prefix}-{view}.png')
        scene.render.filepath = target
        bpy.ops.render.render(write_still=True)
        if not os.path.exists(target) or os.path.getsize(target) == 0:
            raise RuntimeError(f'render wrote nothing for view {view}')
        files.append({
            'view': view,
            'path': target,
            'bytes': os.path.getsize(target),
            'width': width,
            'height': height,
        })
    return files


# #endregion


def main() -> int:
    spec = read_spec()
    result_path = spec.get('resultPath')
    try:
        reset_scene()
        obj = build_solid(spec.get('solids', []))
        triangles, vertices, bbox = measure(obj)
        mode = str(spec.get('mode') or 'solid').lower()
        if mode == 'solid':
            export_solid(obj, str(spec.get('format') or 'stl'), str(spec['outputPath']))
            payload = {'ok': True, 'mode': mode, 'triangles': triangles, 'vertices': vertices,
                       'bbox': bbox, 'files': []}
        else:
            files = render_views(obj, spec, bbox)
            payload = {'ok': True, 'mode': mode, 'triangles': triangles, 'vertices': vertices,
                       'bbox': bbox, 'files': files}
        write_result(result_path, payload)
        print('CAD_OK', json.dumps({'triangles': triangles, 'vertices': vertices}))
        return 0
    except BaseException as cause:  # noqa: BLE001 - report everything to the host
        write_result(result_path, {
            'ok': False,
            'error': f'{type(cause).__name__}: {cause}',
            'traceback': traceback.format_exc(),
        })
        print('CAD_FAIL', f'{type(cause).__name__}: {cause}')
        return 1


if __name__ == '__main__':
    sys.exit(main())
