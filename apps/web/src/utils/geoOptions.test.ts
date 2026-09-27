import { describe, expect, it } from 'vitest';
import { displayGeoOptions } from './geoOptions';

describe('Geo 50:50 option labels', () => {
  it('keeps A and D at their original positions after B and C are eliminated', () => {
    const options = ['A', 'B', 'C', 'D'].map(id => ({ id, text: id }));
    const displayed = displayGeoOptions(options, ['B', 'C']);
    expect(displayed.map(item => [item.label, item.eliminated])).toEqual([
      ['A', false], ['B', true], ['C', true], ['D', false],
    ]);
    expect(displayed.filter(item => !item.eliminated).map(item => item.label)).toEqual(['A', 'D']);
  });
});
