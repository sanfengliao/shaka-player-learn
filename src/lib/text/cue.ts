/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArrayUtils } from '../util/array_utils';

/**
 * @export
 */
export class Cue {
  /**
   * @enum {number}
   */
  static positionAlign = {
    LEFT: 'line-left',
    RIGHT: 'line-right',
    CENTER: 'center',
    AUTO: 'auto',
  };

  /**
   * @enum {number}
   */
  static textAlign = {
    LEFT: 'left',
    RIGHT: 'right',
    CENTER: 'center',
    START: 'start',
    END: 'end',
  };

  /**
   * Vertical alignments of the cues within their extents.
   * 'BEFORE' means displaying at the top of the captions container box, 'CENTER'
   *  means in the middle, 'AFTER' means at the bottom.
   * @enum {string}
   * @export
   */

  static displayAlign = {
    BEFORE: 'before',
    CENTER: 'center',
    AFTER: 'after',
  };

  /**
   * @enum {number}
   */
  static direction = {
    HORIZONTAL_LEFT_TO_RIGHT: 'ltr',
    HORIZONTAL_RIGHT_TO_LEFT: 'rtl',
  };

  /**
   * @enum {number}
   */
  static writingMode = {
    HORIZONTAL_TOP_TO_BOTTOM: 'horizontal-tb',
    VERTICAL_LEFT_TO_RIGHT: 'vertical-lr',
    VERTICAL_RIGHT_TO_LEFT: 'vertical-rl',
  };

  /**
   * @enum {number}
   */
  static lineInterpretation = {
    LINE_NUMBER: 0,
    PERCENTAGE: 1,
  };

  /**
   * @enum {number}
   */
  static lineAlign = {
    CENTER: 'center',
    START: 'start',
    END: 'end',
  };

  static defaultTextColor = {
    white: 'white',
    lime: 'lime',
    cyan: 'cyan',
    red: 'red',
    yellow: 'yellow',
    magenta: 'magenta',
    blue: 'blue',
    black: 'black',
  };

  static defaultTextBackgroundColor = {
    bg_white: 'white',
    bg_lime: 'lime',
    bg_cyan: 'cyan',
    bg_red: 'red',
    bg_yellow: 'yellow',
    bg_magenta: 'magenta',
    bg_blue: 'blue',
    bg_black: 'black',
  };

  static fontStyle = {
    NORMAL: 'normal',
    ITALIC: 'italic',
    OBLIQUE: 'oblique',
  };

  static fontWeight = {
    NORMAL: 400,
    BOLD: 700,
  };

  static textDecoration = {
    UNDERLINE: 'underline',
    LINE_THROUGH: 'lineThrough',
    OVERLINE: 'overline',
  };

  startTime: number;
  endTime: number;
  region: CueRegion;
  payload: string;

  /**
   * The indent (in percent) of the cue box in the direction defined by the
   * writing direction.
   * @type {?number}
   * @export
   */
  position = 0;

  /**
   * Position alignment of the cue.
   * @type {shaka.text.Cue.positionAlign}
   * @export
   */
  positionAlign = Cue.positionAlign.AUTO;

  /**
   * Size of the cue box (in percents), where 0 means "auto".
   * @type {number}
   * @export
   */
  size = 0;

  /**
   * Alignment of the text inside the cue box.
   * @type {shaka.text.Cue.textAlign}
   * @export
   */
  textAlign = Cue.textAlign.CENTER;

  /**
   * Text direction of the cue.
   * @type {shaka.text.Cue.direction}
   * @export
   */
  direction = Cue.direction.HORIZONTAL_LEFT_TO_RIGHT;

  /**
   * Text writing mode of the cue.
   * @type {shaka.text.Cue.writingMode}
   * @export
   */
  writingMode = Cue.writingMode.HORIZONTAL_TOP_TO_BOTTOM;

  /**
   * The way to interpret line field. (Either as an integer line number or
   * percentage from the display box).
   * @type {shaka.text.Cue.lineInterpretation}
   * @export
   */
  lineInterpretation = Cue.lineInterpretation.LINE_NUMBER;

  /**
   * The offset from the display box in either number of lines or
   * percentage depending on the value of lineInterpretation.
   * @type {?number}
   * @export
   */
  line = 0;

  /**
   * Separation between line areas inside the cue box in px or em
   * (e.g. '100px'/'100em'). If not specified, this should be no less than
   * the largest font size applied to the text in the cue.
   * @type {string}.
   * @export
   */
  lineHeight = '';

  /**
   * Line alignment of the cue box.
   * Start alignment means the cue box’s top side (for horizontal cues), left
   * side (for vertical growing right), or right side (for vertical growing
   * left) is aligned at the line.
   * Center alignment means the cue box is centered at the line.
   * End alignment The cue box’s bottom side (for horizontal cues), right side
   * (for vertical growing right), or left side (for vertical growing left) is
   * aligned at the line.
   * @type {shaka.text.Cue.lineAlign}
   * @export
   */
  lineAlign = Cue.lineAlign.START;

  /**
   * Vertical alignments of the cues within their extents.
   * 'BEFORE' means displaying the captions at the top of the text display
   * container box, 'CENTER' means in the middle, 'AFTER' means at the bottom.
   * @type {shaka.text.Cue.displayAlign}
   * @export
   */
  displayAlign = Cue.displayAlign.AFTER;

  /**
   * Text color as a CSS color, e.g. "#FFFFFF" or "white".
   * @type {string}
   * @export
   */
  color = '';

  /**
   * Text background color as a CSS color, e.g. "#FFFFFF" or "white".
   * @type {string}
   * @export
   */
  backgroundColor = '';

  /**
   * The URL of the background image, e.g. "data:[mime type];base64,[data]".
   * @type {string}
   * @export
   */
  backgroundImage = '';

  /**
   * The border around this cue as a CSS border.
   * @type {string}
   * @export
   */
  border = '';

  /**
   * Text font size in px or em (e.g. '100px'/'100em').
   * @type {string}
   * @export
   */
  fontSize = '';

  /**
   * Text font weight. Either normal or bold.
   * @type {shaka.text.Cue.fontWeight}
   * @export
   */
  fontWeight = Cue.fontWeight.NORMAL;

  /**
   * Text font style. Normal, italic or oblique.
   * @export
   */
  fontStyle = Cue.fontStyle.NORMAL;

  /**
   * Text font family.
   * @type {string}
   * @export
   */
  fontFamily = '';

  /**
   * Text letter spacing as a CSS letter-spacing value.
   * @type {string}
   * @export
   */
  letterSpacing = '';

  /**
   * Text line padding as a CSS line-padding value.
   * @type {string}
   * @export
   */
  linePadding = '';

  /**
   * Opacity of the cue element, from 0-1.
   * @type {number}
   * @export
   */
  opacity = 1;

  /**
   * Text combine upright as a CSS text-combine-upright value.
   * @type {string}
   * @export
   */
  textCombineUpright = '';

  /**
   * Text decoration. A combination of underline, overline
   * and line through. Empty array means no decoration.
   * @type Cue.textDecoration
   * @export
   */
  textDecoration: string[] = [];

  /**
   * Text shadow color as a CSS text-shadow value.
   * @type {string}
   * @export
   */
  textShadow = '';

  /**
   * Text stroke color as a CSS color, e.g. "#FFFFFF" or "white".
   * @type {string}
   * @export
   */
  textStrokeColor = '';

  /**
   * Text stroke width as a CSS stroke-width value.
   * @type {string}
   * @export
   */
  textStrokeWidth = '';

  /**
   * Whether or not line wrapping should be applied to the cue.
   * @type {boolean}
   * @export
   */
  wrapLine = true;

  /**
   * Id of the cue.
   * @type {string}
   * @export
   */
  id = '';

  /**
   * Nested cues, which should be laid out horizontally in one block.
   * Top-level cues are blocks, and nested cues are inline elements.
   * Cues can be nested arbitrarily deeply.
   * @type {!Array.<!shaka.text.Cue>}
   * @export
   */
  nestedCues: Cue[] = [];

  /**
   * If true, this represents a container element that is "above" the main
   * cues. For example, the <body> and <div> tags that contain the <p> tags
   * in a TTML file. This controls the flow of the final cues; any nested cues
   * within an "isContainer" cue will be laid out as separate lines.
   * @type {boolean}
   * @export
   */
  isContainer = false;

  /**
   * Whether or not the cue only acts as a line break between two nested cues.
   * Should only appear in nested cues.
   * @type {boolean}
   * @export
   */
  lineBreak = false;

  /**
   * Used to indicate the type of ruby tag that should be used when rendering
   * the cue. Valid values: ruby, rp, rt.
   * @type {?string}
   * @export
   */
  rubyTag = '';

  /**
   * The number of horizontal and vertical cells into which the Root Container
   * Region area is divided.
   *
   * @type {{ columns: number, rows: number }}
   * @export
   */
  cellResolution = {
    columns: 32,
    rows: 15,
  };

  /**
   * @enum {number}
  /**
   * @param {number} startTime
   * @param {number} endTime
   * @param {string} payload
   */
  constructor(startTime: number, endTime: number, payload: string) {
    /**
     * The start time of the cue in seconds, relative to the start of the
     * presentation.
     * @type {number}
     * @export
     */
    this.startTime = startTime;

    /**
     * The end time of the cue in seconds, relative to the start of the
     * presentation.
     * @type {number}
     * @export
     */
    this.endTime = endTime;

    /**
     * The text payload of the cue.  If nestedCues is non-empty, this should be
     * empty.  Top-level block containers should have no payload of their own.
     * @type {string}
     * @export
     */
    this.payload = payload;

    /**
     * The region to render the cue into.  Only supported on top-level cues,
     * because nested cues are inline elements.
     * @type {shaka.text.CueRegion}
     * @export
     */
    this.region = new CueRegion();
  }

  /**
   * @param {number} start
   * @param {number} end
   * @return {!shaka.text.Cue}
   */
  static lineBreak(start: number, end: number) {
    const cue = new Cue(start, end, '');
    cue.lineBreak = true;
    return cue;
  }

  /**
   * Create a copy of the cue with the same properties.
   * @return {!shaka.text.Cue}
   * @suppress {checkTypes} since we must use [] and "in" with a struct type.
   * @export
   */
  clone() {
    const clone = new Cue(0, 0, '');

    for (const k in this) {
      // @ts-expect-error
      clone[k] = this[k];

      // Make copies of array fields, but only one level deep.  That way, if we
      // change, for instance, textDecoration on the clone, we don't affect the
      // original.
      // @ts-expect-error
      if (clone[k] && clone[k].constructor == Array) {
        // @ts-expect-error
        clone[k] = /** @type {!Array} */ clone[k].slice();
      }
    }

    return clone;
  }

  /**
   * Check if two Cues have all the same values in all properties.
   * @return {boolean}
   * @suppress {checkTypes} since we must use [] and "in" with a struct type.
   * @export
   */
  static equal(cue1: Cue, cue2: Cue) {
    // Compare the start time, end time and payload of the cues first for
    // performance optimization.  We can avoid the more expensive recursive
    // checks if the top-level properties don't match.
    // See: https://github.com/shaka-project/shaka-player/issues/3018
    if (cue1.startTime != cue2.startTime || cue1.endTime != cue2.endTime || cue1.payload != cue2.payload) {
      return false;
    }
    for (const k in cue1) {
      if (k == 'startTime' || k == 'endTime' || k == 'payload') {
        // Already compared.
      } else if (k == 'nestedCues') {
        // This uses shaka.text.Cue.equal rather than just this.equal, since
        // otherwise recursing here will unbox the method and cause "this" to be
        // undefined in deeper recursion.
        if (ArrayUtils.equal(cue1.nestedCues, cue2.nestedCues, Cue.equal)) {
          return false;
        }
      } else if (k == 'region' || k == 'cellResolution') {
        for (const k2 in cue1[k]) {
          // @ts-ignore
          if (cue1[k][k2] != cue2[k][k2]) {
            return false;
          }
        }
        // @ts-ignore
      } else if (Array.isArray(cue1[k])) {
        // @ts-ignore
        if (!ArrayUtils.equal(cue1[k], cue2[k])) {
          return false;
        }
      } else {
        // @ts-ignore
        if (cue1[k] != cue2[k]) {
          return false;
        }
      }
    }

    return true;
  }
}

/**
 * @export
 */
export class CueRegion {
  /**
   * @enum {number}
   * @export
   */
  static units = {
    PX: 0,
    PERCENTAGE: 1,
    LINES: 2,
  };

  /**
   * @enum {string}
   * @export
   */
  static scrollMode = {
    NONE: '',
    UP: 'up',
  };
  /**
   * Region identifier.
   * @type {string}
   * @export
   */
  id = '';

  /**
   * The X offset to start the rendering area in viewportAnchorUnits of the
   * video width.
   * @type {number}
   * @export
   */
  viewportAnchorX = 0;

  /**
   * The X offset to start the rendering area in viewportAnchorUnits of the
   * video height.
   * @type {number}
   * @export
   */
  viewportAnchorY = 0;

  /**
   * The X offset to start the rendering area in percentage (0-100) of this
   * region width.
   * @type {number}
   * @export
   */
  regionAnchorX = 0;

  /**
   * The Y offset to start the rendering area in percentage (0-100) of the
   * region height.
   * @type {number}
   * @export
   */
  regionAnchorY = 0;

  /**
   * The width of the rendering area in widthUnits.
   * @type {number}
   * @export
   */
  width = 100;

  /**
   * The width of the rendering area in heightUnits.
   * @type {number}
   * @export
   */
  height = 100;

  /**
   * The units (percentage, pixels or lines) the region height is in.
   * @type {shaka.text.CueRegion.units}
   * @export
   */
  heightUnits = CueRegion.units.PERCENTAGE;

  /**
   * The units (percentage or pixels) the region width is in.
   * @type {shaka.text.CueRegion.units}
   * @export
   */
  widthUnits = CueRegion.units.PERCENTAGE;

  /**
   * The units (percentage or pixels) the region viewportAnchors are in.
   * @type {shaka.text.CueRegion.units}
   * @export
   */
  viewportAnchorUnits = CueRegion.units.PERCENTAGE;

  /**
   * If scroll=UP, it means that cues in the region will be added to the
   * bottom of the region and will push any already displayed cues in the
   * region up.  Otherwise (scroll=NONE) cues will stay fixed at the location
   * they were first painted in.
   * @type {shaka.text.CueRegion.scrollMode}
   * @export
   */
  scroll = CueRegion.scrollMode.NONE;
}
