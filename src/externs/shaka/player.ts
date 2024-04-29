/**
 * @typedef {{
 *   minTotalBytes: number,
 *   minBytes: number,
 *   fastHalfLife: number,
 *   slowHalfLife: number
 * }}
 *
 * @property {number} minTotalBytes
 *   Minimum number of bytes sampled before we trust the estimate.  If we have
 *   not sampled much data, our estimate may not be accurate enough to trust.
 * @property {number} minBytes
 *   Minimum number of bytes, under which samples are discarded.  Our models
 *   do not include latency information, so connection startup time (time to
 *   first byte) is considered part of the download time.  Because of this, we
 *   should ignore very small downloads which would cause our estimate to be
 *   too low.
 * @property {number} fastHalfLife
 *   The quantity of prior samples (by weight) used when creating a new
 *   estimate, in seconds.  Those prior samples make up half of the
 *   new estimate.
 * @property {number} slowHalfLife
 *   The quantity of prior samples (by weight) used when creating a new
 *   estimate, in seconds.  Those prior samples make up half of the
 *   new estimate.
 * @exportDoc
 */
export interface AdvancedAbrConfiguration {
  minTotalBytes: number;
  minBytes: number;
  fastHalfLife: number;
  slowHalfLife: number;
}
