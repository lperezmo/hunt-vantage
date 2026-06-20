// Results panel: ranked vantage cards with a legend, plus GPX export.

export function renderResults(container, spots, { onSelect, onView3d }) {
  container.innerHTML = '';
  if (!spots || !spots.length) {
    container.innerHTML = '<p class="empty">No vantage points found — try a larger or more varied area.</p>';
    return { select: () => {} };
  }

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '<span>poor</span><div class="ramp"></div><span>great</span>';
  container.appendChild(legend);

  const cards = [];
  spots.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <div class="rank">
        <span class="badge">${s.rank}</span>
        <strong>Vantage ${s.rank}</strong>
        <span class="score">score ${s.rating} · ~${s.visibleAcres} ac visible</span>
      </div>
      <p class="why">${s.why}.</p>
      <div class="coords">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} · ${s.elevation} m</div>
      <button class="view3d">▶ 3D stand-eye view</button>`;
    card.addEventListener('click', () => onSelect(s.rank));
    card.querySelector('.view3d').addEventListener('click', (e) => { e.stopPropagation(); onView3d(s.rank); });
    container.appendChild(card);
    cards.push(card);
  });

  const dl = document.createElement('button');
  dl.className = 'ghost';
  dl.style.marginTop = '8px';
  dl.textContent = '⤓ Export waypoints (GPX)';
  dl.addEventListener('click', () => downloadGpx(spots));
  container.appendChild(dl);

  function select(rank) {
    cards.forEach((c, i) => c.classList.toggle('sel', spots[i].rank === rank));
  }
  return { select };
}

function downloadGpx(spots) {
  const pts = spots.map((s) =>
    `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}">
    <ele>${s.elevation}</ele>
    <name>Vantage ${s.rank} (score ${s.rating})</name>
    <desc>${escapeXml(s.why)}. ~${s.visibleAcres} acres visible.</desc>
  </wpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hunt Vantage" xmlns="http://www.topografix.com/GPX/1/1">
${pts}
</gpx>`;
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hunt-vantage-waypoints.gpx';
  a.click();
  URL.revokeObjectURL(a.href);
}

const escapeXml = (s) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
