/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @summary A set of map/object utility functions.
 */
export class MapUtils {
  static asMap(object: Record<string, any>) {
    const map = new Map();
    for (const key of Object.keys(object)) {
      map.set(key, object[key]);
    }

    return map;
  }

  /**
   * @param {!Map.<KEY, VALUE>} map
   * @return {!Object.<KEY, VALUE>}
   * @template KEY,VALUE
   */
  static asObject<K extends string, V>(map: Map<K, V>) {
    const obj: Record<K, V> = {} as any;
    map.forEach((value, key) => {
      obj[key] = value;
    });

    return obj;
  }

  /**
   * NOTE: This only works for simple value types and
   * will not be accurate if map values are objects!
   *
   * @param {Map.<KEY, VALUE>} map1
   * @param {Map.<KEY, VALUE>} map2
   * @return {boolean}
   * @template KEY,VALUE
   */
  static hasSameElements(map1: Map<any, any>, map2: Map<any, any>) {
    if (!map1 && !map2) {
      return true;
    } else if (map1 && !map2) {
      return false;
    } else if (map2 && !map1) {
      return false;
    }

    if (map1.size != map2.size) {
      return false;
    }

    for (const [key, val] of map1) {
      if (!map2.has(key)) {
        return false;
      }

      const val2 = map2.get(key);
      if (val2 != val || val2 == undefined) {
        return false;
      }
    }
    return true;
  }
}
