// Analysis worker: fetch + build the parcel, run the vantage scoring, and ship
// the results (with transferable buffers) back to the main thread. Keeps all
// the heavy lifting off the UI thread.

import { buildParcel } from '../data/build.js';
import { analyze } from './score.js';

self.onmessage = async (e) => {
  const { bbox, ui, runId } = e.data;
  // runId is echoed on every message so the main thread can drop results from
  // a run the user has since cleared or superseded.
  const post = (pct, label) => self.postMessage({ type: 'progress', pct, label, runId });

  try {
    const parcel = await buildParcel(bbox, (pct, label) => post(pct, label));
    post(0.94, 'Scoring vantage points…');
    const result = analyze(parcel, ui);
    post(1, 'Done');

    // collect transferables
    const transfer = [result.heat.buffer, result.heights.buffer, result.forest.buffer];
    for (const s of result.spots) transfer.push(s.footprint.buffer);
    result.texBitmap = parcel.texBitmap || null;
    result.texW = parcel.texW;
    result.texH = parcel.texH;
    if (parcel.texBitmap) transfer.push(parcel.texBitmap);

    self.postMessage({ type: 'result', result, runId }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err), runId });
  }
};
