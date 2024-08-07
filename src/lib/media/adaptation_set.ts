/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Stream, Variant } from '../../externs/shaka/manifest';
import { asserts } from '../debug/asserts';
import { log } from '../debug/log';
import { MimeUtils } from '../util/mime_utils';

/**
 * A set of variants that we want to adapt between.
 *
 * @final
 */
export class AdaptationSet {
  private root_: Variant;
  private variants_: Set<Variant>;
  /**
   *
   * @param root
   *    The variant that all other variants will be tested against when being
   *    added to the adaptation set. If a variant is not compatible with the
   *    root, it will not be added.
   * @param  candidates
   *    Variants that may be compatible with the root and should be added if
   *    compatible. If a candidate is not compatible, it will not end up in the
   *    adaptation set.
   * @param {boolean=} compareCodecs
   * @param {boolean=} enableAudioGroups
   */
  constructor(root: Variant, candidates: Iterable<Variant>, compareCodecs = true, enableAudioGroups = false) {
    this.root_ = root;

    this.variants_ = new Set([root]);

    // Try to add all the candidates. If they cannot be added (because they
    // are not compatible with the root, they will be rejected by |add|.
    candidates = candidates || [];
    for (const candidate of candidates) {
      this.add(candidate, compareCodecs, enableAudioGroups);
    }
  }

  /**
   * @param {shaka.extern.Variant} variant
   * @param {boolean} compareCodecs
   * @param {boolean} enableAudioGroups
   * @return {boolean}
   */
  add(variant: Variant, compareCodecs: boolean, enableAudioGroups: boolean) {
    if (this.canInclude(variant, compareCodecs, enableAudioGroups)) {
      this.variants_.add(variant);
      return true;
    }

    // To be nice, issue a warning if someone is trying to add something that
    // they shouldn't.
    log.warning('Rejecting variant - not compatible with root.');
    return false;
  }

  /**
   * Check if |variant| can be included with the set. If |canInclude| returns
   * |false|, calling |add| will result in it being ignored.
   *
   * @param  variant
   * @param  compareCodecs
   * @param  enableAudioGroups
   * @return
   */
  canInclude(variant: Variant, compareCodecs = true, enableAudioGroups = false) {
    return AdaptationSet.areAdaptable(this.root_, variant, compareCodecs, enableAudioGroups);
  }

  /**
   * @param {shaka.extern.Variant} a
   * @param {shaka.extern.Variant} b
   * @param {boolean} compareCodecs
   * @param {boolean} enableAudioGroups
   * @return {boolean}
   */
  static areAdaptable(a: Variant, b: Variant, compareCodecs: boolean, enableAudioGroups: boolean) {
    // All variants should have audio or should all not have audio.
    if (!!a.audio != !!b.audio) {
      return false;
    }

    // All variants should have video or should all not have video.
    if (!!a.video != !!b.video) {
      return false;
    }

    // If the languages don't match, we should not adapt between them.
    if (a.language != b.language) {
      return false;
    }

    asserts.assert(!!a.audio == !!b.audio, 'Both should either have audio or not have audio.');
    if (a.audio && b.audio && !AdaptationSet.areAudiosCompatible_(a.audio, b.audio, compareCodecs, enableAudioGroups)) {
      return false;
    }

    asserts.assert(!!a.video == !!b.video, 'Both should either have video or not have video.');
    if (a.video && b.video && !AdaptationSet.areVideosCompatible_(a.video, b.video, compareCodecs)) {
      return false;
    }

    return true;
  }

  values() {
    return this.variants_.values();
  }

  /**
   * Check if we can switch between two audio streams.
   *
   * @param a
   * @param b
   * @param compareCodecs
   * @param enableAudioGroups
   * @return

   */
  private static areAudiosCompatible_(a: Stream, b: Stream, compareCodecs: boolean, enableAudioGroups: boolean) {
    // Don't adapt between channel counts, which could annoy the user
    // due to volume changes on downmixing.  An exception is made for
    // stereo and mono, which should be fine to adapt between.
    if (!a.channelsCount || !b.channelsCount || a.channelsCount > 2 || b.channelsCount > 2) {
      if (a.channelsCount != b.channelsCount) {
        return false;
      }
    }

    // We can only adapt between base-codecs.
    if (compareCodecs && !AdaptationSet.canTransitionBetween_(a, b)) {
      return false;
    }

    // Audio roles must not change between adaptations.
    if (!AdaptationSet.areRolesEqual_(a.roles, b.roles)) {
      return false;
    }

    // We can only adapt between the same groupId.
    if (enableAudioGroups && a.groupId !== b.groupId) {
      return false;
    }

    return true;
  }

  /**
   * Check if we can switch between two video streams.
   *
   * @param a
   * @param b
   * @param compareCodecs
   * @return
   */
  private static areVideosCompatible_(a: Stream, b: Stream, compareCodecs: boolean) {
    // We can only adapt between base-codecs.
    if (compareCodecs && !AdaptationSet.canTransitionBetween_(a, b)) {
      return false;
    }

    // Video roles must not change between adaptations.
    if (!AdaptationSet.areRolesEqual_(a.roles, b.roles)) {
      return false;
    }

    return true;
  }

  /**
   * Check if we can switch between two streams based on their codec and mime
   * type.
   *
   * @param a
   * @param b
   * @return
   * @private
   */
  static canTransitionBetween_(a: Stream, b: Stream) {
    if (a.mimeType != b.mimeType) {
      return false;
    }

    // Get the base codec of each codec in each stream.
    const codecsA = MimeUtils.splitCodecs(a.codecs).map((codec) => {
      return MimeUtils.getCodecBase(codec);
    });
    const codecsB = MimeUtils.splitCodecs(b.codecs).map((codec) => {
      return MimeUtils.getCodecBase(codec);
    });

    // We don't want to allow switching between transmuxed and non-transmuxed
    // content so the number of codecs should be the same.
    //
    // To avoid the case where an codec is used for audio and video we will
    // codecs using arrays (not sets). While at this time, there are no codecs
    // that work for audio and video, it is possible for "raw" codecs to be
    // which would share the same name.
    if (codecsA.length != codecsB.length) {
      return false;
    }

    // Sort them so that we can walk through them and compare them
    // element-by-element.
    codecsA.sort();
    codecsB.sort();

    for (let i = 0; i < codecsA.length; i++) {
      if (codecsA[i] != codecsB[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if two role lists are the equal. This will take into account all
   * unique behaviours when comparing roles.
   *
   * @param a
   * @param b
   * @return {boolean}
   * @private
   */
  static areRolesEqual_(a: Iterable<string>, b: Iterable<string>) {
    const aSet = new Set(a);
    const bSet = new Set(b);

    // Remove the main role from the role lists (we expect to see them only
    // in dash manifests).
    const mainRole = 'main';
    aSet.delete(mainRole);
    bSet.delete(mainRole);

    // Make sure that we have the same number roles in each list. Make sure to
    // do it after correcting for 'main'.
    if (aSet.size != bSet.size) {
      return false;
    }

    // Because we know the two sets are the same size, if any item is missing
    // if means that they are not the same.
    for (const x of aSet) {
      if (!bSet.has(x)) {
        return false;
      }
    }

    return true;
  }
}
