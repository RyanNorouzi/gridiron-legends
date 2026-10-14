import { describe, expect, it } from 'vitest';
import { fitLines, fitSegments, measureText, wrapSegments } from '@/ui/render/text';
import { visibleTabWindow } from '@/ui/screens/playcall';

describe('fitLines', () => {
  it('keeps short text as-is', () => {
    expect(fitLines('FIRST DOWN', 200, 2)).toEqual(['FIRST DOWN']);
  });
  it('wraps long text to the width and never exceeds it', () => {
    const text = 'S. HURST TACKLED AT THE ATL 2 BY B. JACOBSON (ASSIST: D. JORDAN), GAIN OF 1.';
    const lines = fitLines(text, 200, 3);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(measureText(l).width).toBeLessThanOrEqual(200);
  });
  it('marks dropped text with an ASCII ellipsis that still fits', () => {
    const lines = fitLines('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT NINE TEN ELEVEN TWELVE', 60, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith('...')).toBe(true);
    expect(measureText(lines[0] as string).width).toBeLessThanOrEqual(60);
  });
});

describe('fitLines separators', () => {
  it('never leaves a comma or a middle dot dangling before the dots', () => {
    for (let w = 40; w <= 200; w += 3) {
      const [line] = fitLines('CONTENT (66) · TEAM PLAYER, LEADER · VETERAN, CLUTCH', w, 1);
      expect(line).toMatch(/\.\.\.$/);
      expect(line).not.toMatch(/[,·]\s*\.\.\.$/);
      expect(measureText(line as string).width).toBeLessThanOrEqual(w);
    }
  });
});

describe('visibleTabWindow', () => {
  const widths = [40, 60, 60, 50, 70, 80, 60];
  it('shows the first tabs that fit when the first is selected', () => {
    expect(visibleTabWindow(widths, 0, 200)).toEqual({ start: 0, end: 2 });
  });
  it('scrolls so the selected tab is visible and fits', () => {
    for (let sel = 0; sel < widths.length; sel++) {
      const w = visibleTabWindow(widths, sel, 200);
      expect(sel).toBeGreaterThanOrEqual(w.start);
      expect(sel).toBeLessThanOrEqual(w.end);
      const used = widths.slice(w.start, w.end + 1).reduce((a, b) => a + b, 0);
      if (w.end > w.start) expect(used).toBeLessThanOrEqual(200);
    }
  });
  it('handles no tabs', () => {
    expect(visibleTabWindow([], 0, 100)).toEqual({ start: 0, end: -1 });
  });
});

describe('fitSegments', () => {
  it('keeps a list that fits unchanged', () => {
    expect(fitSegments('RUN · INSIDE RUN', 200)).toBe('RUN · INSIDE RUN');
  });
  it('drops whole trailing segments instead of ending in a dangling separator', () => {
    const text = 'RUN · INSIDE RUN · SHORT YARDAGE · GOAL LINE';
    const w = measureText('RUN · INSIDE RUN · SHORT YARDAGE').width;
    expect(fitSegments(text, w + 10)).toBe('RUN · INSIDE RUN · SHORT YARDAGE');
    expect(fitSegments(text, w - 1)).toBe('RUN · INSIDE RUN');
  });
  it('cuts the first segment with "..." only when it alone is too wide', () => {
    const out = fitSegments('PLAY ACTION BOOTLEG · RED ZONE', 50);
    expect(out.endsWith('...')).toBe(true);
    expect(measureText(out).width).toBeLessThanOrEqual(50);
  });
});

describe('wrapSegments', () => {
  it('breaks at the separators, keeping each segment whole', () => {
    const text = 'PEACHTREE PAVILION · ATTENDANCE 71,500';
    const lines = wrapSegments(text, measureText('PEACHTREE PAVILION · ATTEND').width);
    expect(lines).toEqual(['PEACHTREE PAVILION', 'ATTENDANCE 71,500']);
  });
  it('keeps a line that fits and word-wraps a segment wider than the line', () => {
    expect(wrapSegments('ATL WON THE TOSS', 200)).toEqual(['ATL WON THE TOSS']);
    const lines = wrapSegments('A VERY LONG SEGMENT OF WORDS · END', 60);
    for (const l of lines) expect(measureText(l).width).toBeLessThanOrEqual(60);
    expect(lines[lines.length - 1]).toBe('END');
  });
});
