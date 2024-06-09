export class ConfigUtils {
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
}
