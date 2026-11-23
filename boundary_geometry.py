"""Exact ray crossing in the boundary's original geographic coordinates."""
import numpy as np


def contains(geometries, x, y):
    x, y = np.asarray(x), np.asarray(y)
    def ring_contains(ring):
        inside = np.zeros(len(x), dtype=bool)
        for a, b in zip(ring[:-1], ring[1:]):
            if a[1] != b[1]:
                inside ^= ((a[1] > y) != (b[1] > y)) & (x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])
        return inside
    inside = np.zeros(len(x), dtype=bool)
    for geometry in geometries:
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        for polygon in polygons:
            keep = ring_contains(polygon[0])
            for hole in polygon[1:]:
                keep &= ~ring_contains(hole)
            inside |= keep
    return inside
