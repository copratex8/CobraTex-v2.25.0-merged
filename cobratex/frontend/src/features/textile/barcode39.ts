/** Code 39 (يقرؤه أي قارئ باركود): n = رفيع، w = عريض؛ 9 عناصر لكل حرف (شريط/فراغ بالتناوب). */
const P: Record<string, string> = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn', G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn',
  K: 'wnnnnnnww', L: 'nnwnnnnww', M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn', S: 'nnwnnnwwn', T: 'nnnnwnwwn',
  U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw', Y: 'wwnnwnnnn', Z: 'nwwnwnnnn',
  '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn', '*': 'nwnnwnwnn', $: 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn',
};
export const CODE39_PATTERNS = P;

/** نص قابل للترميز: أحرف كبيرة ومسموح بها فقط (غيرها يُستبدل بـ-). */
export function code39Text(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z\-. $/+%]/g, '-');
}

/** يُرجع مستطيلات الأشرطة [x, عرض] بوحدات (رفيع=1، عريض=3) + الإجمالي. */
export function code39Bars(value: string): { bars: Array<[number, number]>; width: number } {
  const text = `*${code39Text(value)}*`;
  const bars: Array<[number, number]> = [];
  let x = 0;
  for (let c = 0; c < text.length; c++) {
    const pat = P[text[c]];
    for (let i = 0; i < 9; i++) {
      const w = pat[i] === 'w' ? 3 : 1;
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    }
    x += 1; // فراغ بين الأحرف
  }
  return { bars, width: x - 1 };
}
