import { expect, test } from 'bun:test';
import { comparisonSize } from './viewport';

test('portrait regions fit the available height without distorting the reference', () => {
  const size = comparisonSize(768, 922, 210, 248, 'fit');
  expect(size.height).toBe(248);
  expect(size.width).toBeCloseTo(206.577, 2);
  expect(size.width / size.height).toBeCloseTo(768 / 922);
});
test('zoom uses comp pixels, including tiny texture regions and thin controls', () => {
  expect(comparisonSize(154, 102, 210, 248, 4)).toEqual({scale:4,width:616,height:408});
  expect(comparisonSize(1440, 4, 210, 248, 1)).toEqual({scale:1,width:1440,height:4});
});
