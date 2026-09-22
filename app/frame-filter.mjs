/**
 * @param {Iterable<number>} reviewedFrames
 * @param {Iterable<number>} pendingFrames
 * @returns {number[]}
 */
export function mergeFrameNumbers(reviewedFrames, pendingFrames) {
  return [...new Set([...reviewedFrames, ...pendingFrames])]
    .filter((frame) => Number.isInteger(frame) && frame >= 0)
    .sort((left, right) => left - right);
}

/**
 * @param {number[]} frameNumbers
 * @param {number} currentFrame
 * @param {number} windowSize
 * @returns {number[]}
 */
export function frameWindow(frameNumbers, currentFrame, windowSize) {
  if (!frameNumbers.length || windowSize < 1) return [];
  const currentIndex = Math.max(0, frameNumbers.indexOf(currentFrame));
  const start = Math.floor(currentIndex / windowSize) * windowSize;
  return frameNumbers.slice(start, start + windowSize);
}

/**
 * @param {number[]} frameNumbers
 * @param {number} currentFrame
 * @param {number} direction
 * @returns {number | null}
 */
export function adjacentFrame(frameNumbers, currentFrame, direction) {
  if (direction > 0)
    return frameNumbers.find((frame) => frame > currentFrame) ?? null;
  return frameNumbers.findLast((frame) => frame < currentFrame) ?? null;
}
