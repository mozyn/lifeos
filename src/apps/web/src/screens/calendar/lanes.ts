/**
 * Events side by side in the time grid (round 8f): a weekly note's event has a start only, so it is
 * drawn an hour long, and events whose hours overlap share their day's column. Each gets a lane
 * and the number of lanes of its cluster (the events linked by overlaps).
 */

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/** an event's drawn length in minutes */
export const SPAN = 60;

export function lanes(events: { id: string; time: string }[]): Map<string, { lane: number; of: number }> {
  const out = new Map<string, { lane: number; of: number }>();
  const sorted = [...events].sort((a, b) => toMin(a.time) - toMin(b.time));
  let cluster: string[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const id of cluster) out.get(id)!.of = ends.length;
    cluster = [];
    ends = [];
  };
  for (const e of sorted) {
    const start = toMin(e.time);
    if (start >= clusterEnd) close();
    let lane = ends.findIndex((end) => end <= start);
    if (lane < 0) {
      lane = ends.length;
      ends.push(start + SPAN);
    } else ends[lane] = start + SPAN;
    out.set(e.id, { lane, of: 1 });
    cluster.push(e.id);
    clusterEnd = Math.max(clusterEnd, start + SPAN);
  }
  close();
  return out;
}
