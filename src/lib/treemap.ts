export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TileInput {
  id: number;
  value: number;
}

export interface Tile extends Rect {
  id: number;
  value: number;
}

/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk).
 * Items must be pre-sorted descending by value.
 * Tiles smaller than `minPx` on the short side are dropped (merged away),
 * which is what keeps rendering cheap on million-file trees.
 */
export function squarify(items: TileInput[], rect: Rect, minPx = 1.5): Tile[] {
  const out: Tile[] = [];
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;

  const area = rect.w * rect.h;
  const scale = area / total;
  const queue = items
    .map((i) => ({ id: i.id, value: i.value, area: i.value * scale }))
    .filter((i) => i.area > 0);

  let { x, y, w, h } = rect;
  let idx = 0;

  const worst = (row: number[], side: number) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    const s2 = sum * sum;
    const side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };

  while (idx < queue.length && w > 0.5 && h > 0.5) {
    const horizontal = w >= h;
    const side = horizontal ? h : w;
    const row: number[] = [];
    const rowItems: typeof queue = [];
    let rowSum = 0;

    while (idx < queue.length) {
      const it = queue[idx];
      const next = [...row, it.area];
      if (row.length > 0 && worst(row, side) < worst(next, side)) break;
      row.push(it.area);
      rowItems.push(it);
      rowSum += it.area;
      idx++;
    }

    const thickness = rowSum / side;
    let offset = 0;
    for (const it of rowItems) {
      const len = (it.area / rowSum) * side;
      const tile: Tile = horizontal
        ? { id: it.id, value: it.value, x, y: y + offset, w: thickness, h: len }
        : { id: it.id, value: it.value, x: x + offset, y, w: len, h: thickness };
      if (Math.min(tile.w, tile.h) >= minPx) out.push(tile);
      offset += len;
    }

    if (horizontal) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }
  }

  return out;
}
