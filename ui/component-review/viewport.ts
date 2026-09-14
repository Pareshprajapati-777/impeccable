/** Both panes use comp pixels and the same scale; source-image resolution is separate. */
export function comparisonSize(width: number, height: number, availableWidth: number, availableHeight: number, zoom: 'fit' | number) {
  const scale = zoom === 'fit' ? Math.min(availableWidth / width, availableHeight / height) : zoom;
  return { scale, width: width * scale, height: height * scale };
}
