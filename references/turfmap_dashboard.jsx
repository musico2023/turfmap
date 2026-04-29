import { useState } from 'react';
import { MapPin, TrendingUp, Target, Sparkles, Search, Crosshair, Activity, Crown, Radio, ChevronRight } from 'lucide-react';

const SAMPLE_COMPETITORS = [
  { name: 'Quick Fix Plumbing Co.', amr: 4.2, top3Pct: 67 },
  { name: 'Toronto Pipe Pros', amr: 7.8, top3Pct: 41 },
  { name: 'Maple City Drains', amr: 11.3, top3Pct: 23 }
];

const BRAND_LIME = '#c5ff3a';

function generateGrid(centerRank = 2, radiusFactor = 1.0) {
  const grid = [];
  const size = 9;
  const center = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - center) ** 2 + (y - center) ** 2);
      const baseRank = centerRank + Math.round(dist * 3.4 * radiusFactor);
      const noise = Math.floor(Math.random() * 5) - 2;
      const rank = Math.max(1, Math.min(30, baseRank + noise));
      grid.push({ x, y, rank, dist });
    }
  }
  return grid;
}

function getRankColor(rank) {
  if (rank <= 3) return BRAND_LIME;
  if (rank <= 10) return '#e8e54a';
  if (rank <= 20) return '#ff9f3a';
  return '#ff4d4d';
}

function calculateStats(grid) {
  if (grid.length === 0) return null;
  const ranks = grid.map(c => c.rank);
  const amr = (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1);
  const top3 = grid.filter(c => c.rank <= 3).length;
  const top3Pct = Math.round((top3 / grid.length) * 100);
  let rankRadius = 0;
  for (let r = 0; r <= 5; r++) {
    const ringCells = grid.filter(c => Math.round(c.dist) === r);
    if (ringCells.length === 0) continue;
    const avgRing = ringCells.reduce((a, c) => a + c.rank, 0) / ringCells.length;
    if (avgRing <= 3.5) rankRadius = r;
  }
  return { amr, top3Pct, rankRadius };
}

export default function TurfMapDashboard() {
  const [scanState, setScanState] = useState('idle');
  const [grid, setGrid] = useState([]);
  const [revealedCells, setRevealedCells] = useState(new Set());
  const [insights, setInsights] = useState(null);
  const [insightsLoading, setInsightsLoading] = useState(false);

  const businessName = 'Maple Leaf Plumbing & Drains';
  const address = '142 King St W, Toronto, ON';
  const keyword = 'emergency plumber toronto';

  function runScan() {
    const newGrid = generateGrid(2, 1.0);
    setGrid(newGrid);
    setScanState('scanning');
    setRevealedCells(new Set());
    setInsights(null);

    const cellsByDist = [...newGrid].sort((a, b) => a.dist - b.dist);
    cellsByDist.forEach((cell, i) => {
      setTimeout(() => {
        setRevealedCells(prev => {
          const next = new Set(prev);
          next.add(`${cell.x}-${cell.y}`);
          return next;
        });
        if (i === cellsByDist.length - 1) {
          setScanState('complete');
        }
      }, i * 22);
    });
  }

  async function getInsights() {
    setInsightsLoading(true);
    const stats = calculateStats(grid);

    const prompt = `You are TurfMap AI Coach, a Local SEO strategist for home services businesses. Analyze the following geo-grid scan and return strategic recommendations.

Business: ${businessName}
Service area: Toronto, ON
Keyword tracked: "${keyword}"
TurfScore (Average Map Rank): ${stats.amr}
3-Pack Win Rate: ${stats.top3Pct}% of 81 grid points
TurfRadius: ${stats.rankRadius} grid units (~${(stats.rankRadius * 0.4).toFixed(1)} miles)

Top competitors in 3-pack:
${SAMPLE_COMPETITORS.map(c => `- ${c.name}: AMR ${c.amr}, Top-3% ${c.top3Pct}%`).join('\n')}

Return ONLY valid JSON (no markdown fences, no preamble, no explanation):
{
  "diagnosis": "One sentence identifying the primary visibility problem (proximity, prominence, or relevance)",
  "actions": [
    {"priority": "HIGH", "action": "Specific action in 6-10 words", "why": "One sentence rationale tied to the data"},
    {"priority": "HIGH or MEDIUM", "action": "...", "why": "..."},
    {"priority": "MEDIUM or LOW", "action": "...", "why": "..."}
  ],
  "impact": "One sentence projecting realistic 90-day impact"
}`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await response.json();
      const text = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
      const cleaned = text.replace(/```json|```/g, '').trim();
      setInsights(JSON.parse(cleaned));
    } catch (err) {
      console.error('AI Coach error:', err);
      setInsights({
        diagnosis: 'Strong rankings near the pin but rapid drop-off beyond 1 mile — classic proximity-bound visibility pattern.',
        actions: [
          { priority: 'HIGH', action: 'Build 8 neighborhood landing pages', why: 'Expand relevance signals beyond pin proximity to capture searches farther out.' },
          { priority: 'HIGH', action: 'Drive review velocity to 12+/month', why: 'Top competitor has 67% top-3 rate — review prominence is closing that gap.' },
          { priority: 'MEDIUM', action: 'Audit and fix top 50 citations', why: 'NAP inconsistencies likely capping authority signals to Google.' }
        ],
        impact: 'Expected 40-60% expansion of TurfRadius and 15-25 point lift in 3-Pack Win Rate within 90 days.'
      });
    }
    setInsightsLoading(false);
  }

  const stats = calculateStats(grid);

  return (
    <div className="min-h-screen w-full text-white" style={{ background: '#0a0a0a', fontFamily: 'Geist, system-ui, sans-serif' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,200..800&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400..700&display=swap');
        .display { font-family: 'Bricolage Grotesque', sans-serif; letter-spacing: -0.025em; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 0.7; }
          100% { transform: scale(2.4); opacity: 0; }
        }
        @keyframes scan-sweep {
          0% { transform: translateY(-20px); opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { transform: translateY(560px); opacity: 0; }
        }
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0.3; }
        }
        .pulse-ring { animation: pulse-ring 2.2s ease-out infinite; transform-origin: center; transform-box: fill-box; }
        .scan-sweep { animation: scan-sweep 1.6s ease-in-out infinite; }
        .blink { animation: blink 1.2s steps(2) infinite; }
        .grid-bg { background-image: 
          linear-gradient(rgba(197,255,58,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(197,255,58,0.04) 1px, transparent 1px);
          background-size: 40px 40px;
        }
      `}</style>

      {/* Header */}
      <header className="border-b border-zinc-800 px-8 py-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-md flex items-center justify-center" style={{ background: BRAND_LIME, boxShadow: `0 0 24px ${BRAND_LIME}40` }}>
                <Crosshair size={20} className="text-black" strokeWidth={2.75} />
              </div>
              <div>
                <div className="display text-2xl font-bold tracking-tight leading-none">TurfMap<span className="text-xs align-top ml-0.5" style={{color: BRAND_LIME}}>™</span></div>
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mt-0.5">Geo-grid intelligence</div>
              </div>
            </div>
            <div className="h-8 w-px bg-zinc-800 mx-1" />
            <div className="text-xs text-zinc-500">
              An exclusive feature of <span className="text-zinc-300 font-semibold">Local Lead Machine</span>
            </div>
          </div>
          <div className="flex items-center gap-5 text-xs">
            <span className="mono text-zinc-600">v2.1.4</span>
            <div className="flex items-center gap-1.5 text-zinc-400">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: BRAND_LIME, boxShadow: `0 0 8px ${BRAND_LIME}` }} />
              <span>System operational</span>
            </div>
          </div>
        </div>
      </header>

      {/* Business setup bar */}
      <div className="border-b border-zinc-800 px-8 py-4 grid grid-cols-12 gap-4 items-center">
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">Business</div>
          <div className="text-sm font-medium text-zinc-100">{businessName}</div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">Pin Location</div>
          <div className="text-sm flex items-center gap-1.5 text-zinc-200"><MapPin size={13} className="text-zinc-500" />{address}</div>
        </div>
        <div className="col-span-3">
          <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1.5 font-semibold">Tracking Keyword</div>
          <div className="text-sm mono text-zinc-200">{keyword}</div>
        </div>
        <div className="col-span-3 flex justify-end">
          <button
            onClick={runScan}
            disabled={scanState === 'scanning'}
            className="px-5 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 transition-all hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: BRAND_LIME, color: 'black', boxShadow: `0 4px 16px ${BRAND_LIME}30` }}>
            {scanState === 'idle' && <><Search size={15} strokeWidth={2.75} /> Run TurfScan</>}
            {scanState === 'scanning' && <><Activity size={15} strokeWidth={2.75} className="animate-pulse" /> Scanning territory…</>}
            {scanState === 'complete' && <><Radio size={15} strokeWidth={2.75} /> Re-scan turf</>}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 p-8">
        {/* Heatmap */}
        <div className="col-span-8 border border-zinc-800 rounded-lg p-6 relative overflow-hidden" style={{ background: '#0d0d0d' }}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <div className="flex items-center gap-2.5 mb-1">
                <h3 className="display text-xl font-bold">Territory Heatmap</h3>
                {scanState === 'scanning' && <span className="text-[10px] uppercase tracking-widest text-zinc-500 blink">● Live scan</span>}
              </div>
              <p className="text-xs text-zinc-500">9×9 geo-grid · 81 search points · 1.6mi radius · UULE-based</p>
            </div>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider">
              {[
                { color: BRAND_LIME, label: 'Top 3' },
                { color: '#e8e54a', label: '4–10' },
                { color: '#ff9f3a', label: '11–20' },
                { color: '#ff4d4d', label: '21+' }
              ].map(item => (
                <div key={item.label} className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm" style={{ background: item.color }} />
                  <span className="text-zinc-400">{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="relative aspect-square w-full max-w-2xl mx-auto rounded-md overflow-hidden grid-bg" style={{background: '#080808', backgroundImage: `linear-gradient(rgba(197,255,58,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(197,255,58,0.03) 1px, transparent 1px)`, backgroundSize: '60px 60px'}}>
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 540 540">
              <defs>
                <radialGradient id="centerGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={BRAND_LIME} stopOpacity="0.18" />
                  <stop offset="100%" stopColor={BRAND_LIME} stopOpacity="0" />
                </radialGradient>
                <linearGradient id="scanGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor={BRAND_LIME} stopOpacity="0" />
                  <stop offset="50%" stopColor={BRAND_LIME} stopOpacity="0.6" />
                  <stop offset="100%" stopColor={BRAND_LIME} stopOpacity="0" />
                </linearGradient>
              </defs>

              <circle cx="270" cy="270" r="220" fill="url(#centerGlow)" />

              {/* Stylized streets */}
              <line x1="0" y1="120" x2="540" y2="120" stroke="#1a1a1a" strokeWidth="1.5" />
              <line x1="0" y1="270" x2="540" y2="270" stroke="#202020" strokeWidth="2" />
              <line x1="0" y1="420" x2="540" y2="420" stroke="#1a1a1a" strokeWidth="1.5" />
              <line x1="120" y1="0" x2="120" y2="540" stroke="#1a1a1a" strokeWidth="1.5" />
              <line x1="270" y1="0" x2="270" y2="540" stroke="#202020" strokeWidth="2" />
              <line x1="420" y1="0" x2="420" y2="540" stroke="#1a1a1a" strokeWidth="1.5" />

              {/* Concentric range rings */}
              <circle cx="270" cy="270" r="60" fill="none" stroke="#1f1f1f" strokeWidth="1" strokeDasharray="2 4" />
              <circle cx="270" cy="270" r="120" fill="none" stroke="#1f1f1f" strokeWidth="1" strokeDasharray="2 4" />
              <circle cx="270" cy="270" r="180" fill="none" stroke="#1f1f1f" strokeWidth="1" strokeDasharray="2 4" />

              {/* Scan sweep */}
              {scanState === 'scanning' && (
                <rect x="0" y="0" width="540" height="60" fill="url(#scanGrad)" className="scan-sweep" />
              )}

              {/* Grid points */}
              {grid.map(cell => {
                const cellKey = `${cell.x}-${cell.y}`;
                const isRevealed = revealedCells.has(cellKey);
                const cx = 30 + cell.x * 60;
                const cy = 30 + cell.y * 60;
                const color = getRankColor(cell.rank);
                return (
                  <g key={cellKey} style={{ opacity: isRevealed ? 1 : 0, transition: 'opacity 220ms ease-out' }}>
                    <circle cx={cx} cy={cy} r={isRevealed ? 23 : 0} fill={color} opacity="0.96"
                      style={{ transition: 'r 280ms cubic-bezier(0.2, 1.6, 0.4, 1)' }} />
                    <circle cx={cx} cy={cy} r={isRevealed ? 23 : 0} fill="none" stroke={color} strokeWidth="1" opacity="0.4"
                      style={{ transition: 'r 280ms cubic-bezier(0.2, 1.6, 0.4, 1)' }} />
                    {isRevealed && (
                      <text x={cx} y={cy + 5} textAnchor="middle" fontFamily="'JetBrains Mono', monospace" fontSize="14" fontWeight="700" fill="black">
                        {cell.rank}
                      </text>
                    )}
                  </g>
                );
              })}

              {/* Center pin */}
              {grid.length > 0 && (
                <g>
                  <circle cx="270" cy="270" r="16" fill="white" className="pulse-ring" opacity="0.4" />
                  <circle cx="270" cy="270" r="11" fill="white" stroke="black" strokeWidth="2.5" />
                  <circle cx="270" cy="270" r="5" fill="black" />
                </g>
              )}
            </svg>

            {grid.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5 border border-zinc-800" style={{background: '#0a0a0a'}}>
                  <Crosshair size={28} className="text-zinc-600" strokeWidth={1.5} />
                </div>
                <h4 className="display text-xl font-semibold text-zinc-300">Ready to map your turf</h4>
                <p className="text-sm text-zinc-600 mt-2 max-w-sm">81 simulated searches across a 1.6-mile grid. Scan completes in &lt;3 seconds.</p>
                <button onClick={runScan} className="mt-5 text-xs font-semibold flex items-center gap-1.5" style={{color: BRAND_LIME}}>
                  Begin first scan <ChevronRight size={13} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Stats */}
        <div className="col-span-4 space-y-4">
          <StatCard label="TurfScore™" value={stats ? stats.amr : '—'} subtitle="Average Map Rank · lower is better" icon={Target} />
          <StatCard label="3-Pack Win Rate" value={stats ? `${stats.top3Pct}%` : '—'} subtitle="Of 81 grid points where you rank top 3" icon={Crown} highlight />
          <StatCard label="TurfRadius™" value={stats ? `${(stats.rankRadius * 0.4).toFixed(1)}mi` : '—'} subtitle="Distance you maintain top-3 visibility" icon={TrendingUp} />

          <div className="border border-zinc-800 rounded-lg p-5" style={{ background: '#0d0d0d' }}>
            <div className="flex items-center justify-between mb-3.5">
              <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">3-Pack Competitors</div>
              <span className="text-[10px] mono text-zinc-600">live</span>
            </div>
            <div className="space-y-3">
              {SAMPLE_COMPETITORS.map((c, i) => (
                <div key={c.name} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <span className="mono text-xs text-zinc-600 w-3.5 flex-shrink-0">{i + 1}</span>
                    <span className="text-zinc-200 truncate">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs flex-shrink-0">
                    <span className="mono text-zinc-500">AMR <span className="text-zinc-300 font-semibold">{c.amr}</span></span>
                    <span className="mono text-zinc-500">{c.top3Pct}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* AI Coach */}
        <div className="col-span-12 rounded-lg p-6 relative overflow-hidden border" style={{
          background: 'linear-gradient(135deg, #0d0d0d 0%, #0f1208 100%)',
          borderColor: insights ? '#2d3a14' : '#27272a'
        }}>
          <div className="absolute top-0 right-0 w-96 h-96 rounded-full opacity-10 pointer-events-none" style={{ background: `radial-gradient(circle, ${BRAND_LIME}, transparent 70%)`, transform: 'translate(30%, -30%)' }} />

          <div className="flex items-start justify-between mb-5 relative">
            <div>
              <div className="flex items-center gap-2 mb-1.5">
                <Sparkles size={16} style={{ color: BRAND_LIME }} />
                <h3 className="display text-xl font-bold">TurfMap AI Coach</h3>
                <span className="text-[9px] mono uppercase font-bold tracking-widest px-1.5 py-0.5 rounded" style={{background: '#1a2010', color: BRAND_LIME, border: `1px solid ${BRAND_LIME}40`}}>Powered by Claude</span>
              </div>
              <p className="text-xs text-zinc-500">Strategic recommendations generated from your live heatmap data</p>
            </div>
            {stats && !insights && !insightsLoading && (
              <button
                onClick={getInsights}
                className="px-4 py-2 rounded-md text-xs font-bold border hover:brightness-125 transition-all flex items-center gap-1.5"
                style={{ borderColor: '#2d3a14', color: BRAND_LIME, background: '#0a0f04' }}>
                Generate playbook <ChevronRight size={12} />
              </button>
            )}
          </div>

          {!stats && (
            <div className="text-sm text-zinc-600 italic">Run a TurfScan to unlock AI-powered strategic recommendations.</div>
          )}

          {stats && !insights && !insightsLoading && (
            <div className="text-sm text-zinc-500">81 data points captured. Generate playbook to receive prioritized actions.</div>
          )}

          {insightsLoading && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-zinc-300">
                <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: BRAND_LIME }} />
                Analyzing 81 grid points and competitor positions…
              </div>
              <div className="grid grid-cols-3 gap-4">
                {[0, 1, 2].map(i => (
                  <div key={i} className="border border-zinc-800 rounded-lg p-4 animate-pulse">
                    <div className="h-3 w-12 bg-zinc-800 rounded mb-3" />
                    <div className="h-4 w-full bg-zinc-800 rounded mb-2" />
                    <div className="h-3 w-3/4 bg-zinc-800 rounded" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {insights && (
            <>
              <div className="border-l-2 pl-4 mb-5" style={{ borderColor: BRAND_LIME }}>
                <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-1 font-semibold">Diagnosis</div>
                <p className="text-sm text-zinc-200 leading-relaxed">{insights.diagnosis}</p>
              </div>

              <div className="grid grid-cols-3 gap-4 mb-5">
                {insights.actions.map((action, i) => (
                  <div key={i} className="border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors" style={{background: '#0a0a0a'}}>
                    <div className="flex items-center justify-between mb-2.5">
                      <span className="text-[10px] mono uppercase font-bold tracking-widest px-2 py-0.5 rounded"
                        style={{
                          background: action.priority === 'HIGH' ? BRAND_LIME : action.priority === 'MEDIUM' ? '#ff9f3a' : '#3a3a3a',
                          color: action.priority === 'LOW' ? '#999' : 'black'
                        }}>
                        {action.priority}
                      </span>
                      <span className="mono text-xs text-zinc-700">#{i + 1}</span>
                    </div>
                    <h4 className="text-sm font-semibold text-zinc-100 mb-2 leading-snug">{action.action}</h4>
                    <p className="text-xs text-zinc-500 leading-relaxed">{action.why}</p>
                  </div>
                ))}
              </div>

              <div className="text-xs text-zinc-300 flex items-start gap-2 pt-4 border-t border-zinc-800">
                <TrendingUp size={14} style={{ color: BRAND_LIME }} className="mt-0.5 flex-shrink-0" />
                <span><span className="text-zinc-500 font-semibold uppercase tracking-wider text-[10px] mr-1.5">Projected impact:</span>{insights.impact}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <footer className="border-t border-zinc-800 px-8 py-4 flex items-center justify-between text-xs text-zinc-600">
        <span>© Local Lead Machine · TurfMap™ is proprietary technology of Fourdots Digital</span>
        <span className="mono">Last scan: just now · Next auto-scan: Mon 6:00 AM EST</span>
      </footer>
    </div>
  );
}

function StatCard({ label, value, subtitle, icon: Icon, highlight }) {
  return (
    <div className="border rounded-lg p-5 relative overflow-hidden" style={{
      background: highlight ? 'linear-gradient(135deg, #0d0d0d 0%, #0f1208 100%)' : '#0d0d0d',
      borderColor: highlight ? '#2d3a14' : '#27272a'
    }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">{label}</div>
        <Icon size={14} className="text-zinc-600" />
      </div>
      <div className="display text-4xl font-bold mb-1.5 leading-none" style={{ color: highlight ? BRAND_LIME : 'white' }}>{value}</div>
      <div className="text-xs text-zinc-500 leading-relaxed">{subtitle}</div>
    </div>
  );
}
