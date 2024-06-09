import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { ObjectUtils } from './object_utils';

export class ConfigUtils {
  /**
   * @param {!Object} destination
   * @param {!Object} source
   * @param {!Object} template supplies default values
   * @param {!Object} overrides
   *   Supplies override type checking.  When the current path matches
   *   the key in this object, each sub-value must match the type in this
   *   object. If this contains an Object, it is used as the template.
   * @param {string} path to this part of the config
   * @return {boolean}
   * @export
   */
  static mergeConfigObjects(
    destination: Record<string, any>,
    source: Record<string, any>,
    template: Record<string, any>,
    overrides: Record<string, any>,
    path: string
  ): boolean {
    asserts.assert(destination, 'Destination config must not be null!');

    // If true, override the template.
    const overrideTemplate = path in overrides;

    // If true, treat the source as a generic object to be copied without
    // descending more deeply.
    let genericObject = false;
    if (overrideTemplate) {
      genericObject = template.constructor == Object && Object.keys(overrides).length == 0;
    } else {
      genericObject = template.constructor == Object && Object.keys(template).length == 0;
    }

    // If true, don't validate the keys in the next level.
    const ignoreKeys = overrideTemplate || genericObject;

    let isValid = true;

    for (const k in source) {
      const subPath = path + '.' + k;
      const subTemplate = overrideTemplate ? overrides[path] : template[k];

      // The order of these checks is important.
      if (!ignoreKeys && !(k in template)) {
        log.alwaysError('Invalid config, unrecognized key ' + subPath);
        isValid = false;
      } else if (source[k] === undefined) {
        // An explicit 'undefined' value causes the key to be deleted from the
        // destination config and replaced with a default from the template if
        // possible.
        if (subTemplate === undefined || ignoreKeys) {
          // There is nothing in the template, so delete.
          delete destination[k];
        } else {
          // There is something in the template, so go back to that.
          destination[k] = ObjectUtils.cloneObject(subTemplate);
        }
      } else if (genericObject) {
        // Copy the fields of a generic object directly without a template and
        // without descending any deeper.
        destination[k] = source[k];
      } else if (subTemplate.constructor == Object && source[k] && source[k].constructor == Object) {
        // These are plain Objects with no other constructor.

        if (!destination[k]) {
          // Initialize the destination with the template so that normal
          // merging and type-checking can happen.
          destination[k] = ObjectUtils.cloneObject(subTemplate);
        }

        const subMergeValid = ConfigUtils.mergeConfigObjects(
          destination[k],
          source[k],
          subTemplate,
          overrides,
          subPath
        );
        isValid = isValid && subMergeValid;
      } else if (
        typeof source[k] != typeof subTemplate ||
        source[k] == null ||
        // Function cosntructors are not informative, and differ
        // between sync and async functions.  So don't look at
        // constructor for function types.
        (typeof source[k] != 'function' && source[k].constructor != subTemplate.constructor)
      ) {
        // The source is the wrong type.  This check allows objects to be
        // nulled, but does not allow null for any non-object fields.
        log.alwaysError('Invalid config, wrong type for ' + subPath);
        isValid = false;
      } else if (typeof template[k] == 'function' && template[k].length != source[k].length) {
        log.alwaysWarn('Unexpected number of arguments for ' + subPath);
        destination[k] = source[k];
      } else {
        destination[k] = source[k];
      }
    }

    return isValid;
  }
  /**
   * Convert config from ('fieldName', value) format to a partial config object.
   *
   * E. g. from ('manifest.retryParameters.maxAttempts', 1) to
   * { manifest: { retryParameters: { maxAttempts: 1 }}}.
   *
   * @param {string} fieldName
   * @param {*} value
   * @return {!Object}
   * @export
   */
  static convertToConfigObject(fieldName: string, value: any) {
    const configObject: Record<string, any> = {};
    let last = configObject;
    let searchIndex = 0;
    let nameStart = 0;
    while (true) {
      // eslint-disable-line no-constant-condition
      const idx = fieldName.indexOf('.', searchIndex);
      if (idx < 0) {
        break;
      }
      if (idx == 0 || fieldName[idx - 1] != '\\') {
        const part = fieldName.substring(nameStart, idx).replace(/\\\./g, '.');
        last[part] = {};
        last = last[part];
        nameStart = idx + 1;
      }
      searchIndex = idx + 1;
    }

    last[fieldName.substring(nameStart).replace(/\\\./g, '.')] = value;
    return configObject;
  }
  /**
   * Reference the input parameters so the compiler doesn't remove them from
   * the calling function.  Return whatever value is specified.
   *
   * This allows an empty or default implementation of a config callback that
   * still bears the complete function signature even in compiled mode.
   *
   * The caller should look something like this:
   *
   *   const callback = (a, b, c, d) => {
   *     return referenceParametersAndReturn(
             [a, b, c, d],
             a);  // Can be anything, doesn't need to be one of the parameters
   *   };
   *
   * @param  parameters
   * @param  returnValue
   * @return
   */
  static referenceParametersAndReturn<T>(parameters: any[], returnValue: T): T {
    return parameters && returnValue;
  }

  static getDifferenceFromConfigObjects(object: Record<string, any>, base: Record<string, any>) {
    const isObject = (obj: object) => {
      return obj && typeof obj === 'object' && !Array.isArray(obj);
    };

    const isArrayEmpty = (array: any[]) => {
      return Array.isArray(array) && array.length === 0;
    };

    const changes = (object: Record<string, any>, base: Record<string, any>) => {
      return Object.keys(object).reduce((acc, key) => {
        const value = object[key];

        if (!base.hasOwnProperty(key)) {
          acc[key] = value;
        } else if (isObject(value) && isObject(base[key])) {
          const diff = changes(value, base[key]);
          if (Object.keys(diff).length > 0 || !isObject(diff)) {
            acc[key] = diff;
          }
        } else if (isArrayEmpty(value) && isArrayEmpty(base[key])) {
          // Do nothing if both are empty arrays
        } else if (value !== base[key]) {
          acc[key] = value;
        }
        return acc;
      }, {} as Record<string, any>);
    };

    const diff = changes(object, base);

    const removeEmpty = (obj: Record<string, any>) => {
      for (const key of Object.keys(obj)) {
        if (isObject(obj[key]) && Object.keys(obj[key]).length === 0) {
          delete obj[key];
        } else if (isArrayEmpty(obj[key])) {
          delete obj[key];
        } else if (typeof obj[key] == 'function') {
          delete obj[key];
        } else if (isObject(obj[key])) {
          removeEmpty(obj[key]);
        }
      }
    };

    removeEmpty(diff);
    return diff;
  }
}
