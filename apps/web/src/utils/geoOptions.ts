/** Preserve the option's original position when 50:50 eliminates answers. */
export function displayGeoOptions<T extends { id: string; text: string; label?: string }>(
  options: T[], eliminatedIds: string[]
): Array<{ option: T; label: string; eliminated: boolean }> {
  return options.map((option, index) => ({
    option,
    label: /^[A-D]$/.test(option.label ?? '') ? option.label! : ['A', 'B', 'C', 'D'][index] ?? String(index + 1),
    eliminated: eliminatedIds.includes(option.id),
  }));
}
