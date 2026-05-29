import { useState, useEffect, useCallback, useRef } from "react";
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ── Kleuren ───────────────────────────────────────────────────────────────────
const C = {
  bg:      "#0f1520",
  card:    "#161f30",
  border:  "#1e2d42",
  acgt:    "#4dabf7",
  rcgt:    "#ff6b81",
  text:    "#dce8f5",
  dim:     "#5c7a90",
  mid:     "#8fafc4",
  jacobs:  "#4dabf7",
  critici: "#ff9f43",
  green:   "#51cf66",
  amber:   "#fcc419",
  teal:    "#20c997",
};

const HOUSEHOLDS = [
  { id:"small",  label:"Kleine spaarder",    icon:"🏠", start:50_000,    color:"#51cf66" },
  { id:"middle", label:"Middenklasse",        icon:"🏡", start:300_000,   color:"#4dabf7" },
  { id:"large",  label:"Vermogende belegger", icon:"🏢", start:2_000_000, color:"#cc5de8" },
];

const PRESETS = {
  jacobs: {
    YEARS:30, RISK_AVERSION:5, BEQUEST_WEIGHT:1000, PATIENCE:0.96,
    SAFE_RETURN:0.02, STOCK_RETURN_MEAN:0.085, STOCK_VOLATILITY:0.18,
    BASE_TAX_RATE:0.36, RCGT_OVERRIDE:null,
    LOSS_OFFSET:1.0, LIQUIDITY_COST:0.0,
    BUDGET_NEUTRAL:true, ANNUAL_CONTRIBUTION:0, N:600,
  },
  critici: {
    YEARS:30, RISK_AVERSION:5, BEQUEST_WEIGHT:100, PATIENCE:0.96,
    SAFE_RETURN:0.02, STOCK_RETURN_MEAN:0.085, STOCK_VOLATILITY:0.18,
    BASE_TAX_RATE:0.36, RCGT_OVERRIDE:0.36,
    LOSS_OFFSET:0.5, LIQUIDITY_COST:0.02,
    BUDGET_NEUTRAL:false, ANNUAL_CONTRIBUTION:10000, N:600,
  },
};

// ── Simulatie ─────────────────────────────────────────────────────────────────
// Directe simulatie zonder complexe optimalisatietheorie.
// ACGT: elk jaar belasting op rente + papieren aandelenwinst
// RCGT: elk jaar alleen belasting op rente; aandelen groeien belastingvrij;
//       eindbelasting op totale aandelenwinst bij verkoop (jaar T)
function bm() {
  let u,v;
  do{u=Math.random();}while(!u);
  do{v=Math.random();}while(!v);
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}

function simulate(cfg, startWealth) {
  const {YEARS, SAFE_RETURN, STOCK_RETURN_MEAN, STOCK_VOLATILITY,
    BASE_TAX_RATE, RCGT_OVERRIDE, LOSS_OFFSET, LIQUIDITY_COST,
    BUDGET_NEUTRAL, ANNUAL_CONTRIBUTION, N:M,
    RISK_AVERSION} = cfg;

  const Rf = 1 + SAFE_RETURN;
  const mu = Math.log(1 + STOCK_RETURN_MEAN) - 0.5 * STOCK_VOLATILITY ** 2;

  // Vaste aandelenweging: lager bij hogere risicoaversie
  // RCGT: hogere weging want aandelen niet jaarlijks belast -> aantrekkelijker
  const alphaACGT = Math.min(0.9, Math.max(0.1, 1.2 / RISK_AVERSION));
  const alphaRCGT = Math.min(0.95, alphaACGT * 1.15); // ~15% hoger onder RCGT

  // Consumptiequote: elk jaar x% van vermogen opnemen
  // Laag erfenismotief = hogere consumptie (snellere daling)
  const BEQUEST = cfg.BEQUEST_WEIGHT;
  const consumeRate = Math.max(0.01, Math.min(0.12, 0.08 - BEQUEST / 100000));

  // Dezelfde willekeurige rendementen voor beide systemen
  const Rr = Array.from({length:M}, () =>
    Array.from({length:YEARS}, () => Math.exp(mu + STOCK_VOLATILITY * bm()))
  );

  // Bepaal RCGT eindtarief
  // Budgetneutraal: RCGT-tarief is HOGER dan ACGT omdat belasting uitgesteld wordt
  // Critici (zelfde tarief): RCGT_OVERRIDE = BASE_TAX_RATE
  let tauRCGT = RCGT_OVERRIDE ?? BASE_TAX_RATE;
  if (BUDGET_NEUTRAL && !RCGT_OVERRIDE) {
    // Vuistregel: uitstel over YEARS jaar bij rendement r vraagt opslag
    // PV(jaarbelasting ACGT) = eindbelasting RCGT / (1+r)^T
    // → tauRCGT = BASE_TAX_RATE * (1+stockReturn)^T / YEARS (benadering)
    const grossUp = Math.pow(1 + STOCK_RETURN_MEAN * alphaRCGT, YEARS);
    tauRCGT = Math.min(0.95, BASE_TAX_RATE * (1 + Math.log(grossUp) / YEARS * YEARS * 0.5));
  }

  // ── Simuleer ACGT ──────────────────────────────────────────────────────────
  const WA  = Array.from({length:M}, () => new Float64Array(YEARS+1));
  const TaxA = Array.from({length:M}, () => new Float64Array(YEARS));

  for (let m = 0; m < M; m++) {
    WA[m][0] = startWealth;
    for (let t = 0; t < YEARS; t++) {
      const W = WA[m][t] + ANNUAL_CONTRIBUTION;
      const stockPart = alphaACGT * W;
      const safePart  = (1 - alphaACGT) * W;
      const r = Rr[m][t];

      // Rendement dit jaar
      const stockGain = stockPart * (r - 1);
      const safeGain  = safePart * (Rf - 1);

      // ACGT: betaal belasting over BEIDE — ook papieren aandelenwinst
      const taxStock = stockGain >= 0
        ? BASE_TAX_RATE * stockGain
        : -BASE_TAX_RATE * Math.abs(stockGain) * LOSS_OFFSET; // verliesverrekening
      const taxSafe  = BASE_TAX_RATE * safeGain;
      const totalTax = taxSafe + taxStock;

      // Liquiditeitskosten: als belasting niet uit cashflow betaald kan worden
      const liqCost = LIQUIDITY_COST * Math.max(totalTax - safeGain * 0.3, 0);

      TaxA[m][t] = Math.max(totalTax, 0);
      const netGrowth = stockGain + safeGain - totalTax - liqCost;
      const consumption = consumeRate * W;
      WA[m][t+1] = Math.max(W + netGrowth - consumption, 0);
    }
  }

  // ── Simuleer RCGT ──────────────────────────────────────────────────────────
  const WR  = Array.from({length:M}, () => new Float64Array(YEARS+1));
  const TaxR = Array.from({length:M}, () => new Float64Array(YEARS));

  for (let m = 0; m < M; m++) {
    WR[m][0] = startWealth;
    let costBasis = startWealth; // aankoopprijs voor eindbelasting

    for (let t = 0; t < YEARS; t++) {
      const W = WR[m][t] + ANNUAL_CONTRIBUTION;
      costBasis += ANNUAL_CONTRIBUTION; // nieuwe inleg verhoogt kostprijs
      const stockPart = alphaRCGT * W;
      const safePart  = (1 - alphaRCGT) * W;
      const r = Rr[m][t];

      const stockGain = stockPart * (r - 1);
      const safeGain  = safePart * (Rf - 1);

      // RCGT: alleen belasting over rente — aandelen groeien BELASTINGVRIJ
      const taxSafe = BASE_TAX_RATE * safeGain;
      TaxR[m][t] = Math.max(taxSafe, 0);

      const netGrowth = stockGain + safeGain - taxSafe;
      const consumption = consumeRate * W;
      WR[m][t+1] = Math.max(W + netGrowth - consumption, 0);

      // Eindbelasting op aandelenwinst (betaald in het laatste jaar)
      if (t === YEARS - 1) {
        const totalGain = WR[m][YEARS] - costBasis;
        const stockGainTotal = totalGain * alphaRCGT;
        const termTax = stockGainTotal >= 0
          ? tauRCGT * stockGainTotal
          : -tauRCGT * Math.abs(stockGainTotal) * LOSS_OFFSET;
        const netTermTax = Math.max(termTax, 0);
        TaxR[m][YEARS-1] += netTermTax;
        WR[m][YEARS] = Math.max(WR[m][YEARS] - netTermTax, 0);
      }
    }
  }

  // ── Tijdreeksen ────────────────────────────────────────────────────────────
  const avg = (arr, t) => arr.reduce((s, x) => s + x[t], 0) / arr.length;
  const pct25 = (arr, t) => {
    const v = [...arr.map(x => x[t])].sort((a,b) => a-b);
    return v[Math.floor(0.25 * v.length)];
  };
  const pct75 = (arr, t) => {
    const v = [...arr.map(x => x[t])].sort((a,b) => a-b);
    return v[Math.floor(0.75 * v.length)];
  };

  let cumA = 0, cumR = 0;
  const wealth = Array.from({length: YEARS+1}, (_, t) => ({
    t,
    acgt: Math.round(avg(WA, t)),
    rcgt: Math.round(avg(WR, t)),
    acgtLo: Math.round(pct25(WA, t)),
    acgtHi: Math.round(pct75(WA, t)),
    rcgtLo: Math.round(pct25(WR, t)),
    rcgtHi: Math.round(pct75(WR, t)),
  }));

  const taxCum = Array.from({length: YEARS}, (_, t) => {
    cumA += avg(TaxA, t);
    cumR += avg(TaxR, t);
    return { t: t+1, acgt: Math.round(cumA), rcgt: Math.round(cumR) };
  });

  return {
    wealth, taxCum, tauRCGT,
    eindACGT: Math.round(avg(WA, YEARS)),
    eindRCGT: Math.round(avg(WR, YEARS)),
    totTaxACGT: Math.round(cumA),
    totTaxRCGT: Math.round(cumR),
    alphaACGT, alphaRCGT,
  };
}

function runAll(cfg) {
  return Object.fromEntries(HOUSEHOLDS.map(h => [h.id, simulate(cfg, h.start)]));
}

// ── Opmaakhulpen ──────────────────────────────────────────────────────────────
const fmt=v=>v>=1e6?`€${(v/1e6).toFixed(2)}M`:v>=1000?`€${(v/1000).toFixed(0)}k`:`€${v}`;
const pct=v=>`${(v*100).toFixed(0)}%`;
const pct1=v=>`${(v*100).toFixed(1)}%`;

// ── Tooltip ───────────────────────────────────────────────────────────────────
function ChartTip({active,payload,label}){
  if(!active||!payload?.length)return null;
  const skip=new Set(["acgtLo","acgtHi","rcgtLo","rcgtHi"]);
  return(
    <div style={{background:"#0f1520ee",border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 14px",fontSize:12,backdropFilter:"blur(8px)"}}>
      <div style={{color:C.dim,marginBottom:6,fontWeight:600}}>{label}</div>
      {payload.filter(p=>!skip.has(p.dataKey)).map((p,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:i<payload.filter(x=>!skip.has(x.dataKey)).length-1?4:0}}>
          <div style={{width:10,height:10,borderRadius:"50%",background:p.color,flexShrink:0}}/>
          <span style={{color:C.mid,flex:1}}>{p.name}</span>
          <span style={{color:C.text,fontWeight:700,fontVariantNumeric:"tabular-nums"}}>{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Aanname-rij met uitklapbare uitleg ────────────────────────────────────────
function Assumption({label,jacobsNote,criticiNote,children}){
  const [open,setOpen]=useState(false);
  return(
    <div style={{marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
        <span style={{fontSize:13,color:C.text,fontWeight:600}}>{label}</span>
        <button onClick={()=>setOpen(o=>!o)}
          style={{background:"none",border:`1px solid ${C.border}`,borderRadius:5,
            padding:"2px 8px",fontSize:10,color:open?C.teal:C.dim,cursor:"pointer",whiteSpace:"nowrap",marginLeft:8}}>
          {open?"▲ sluiten":"▼ wat nemen wie aan?"}
        </button>
      </div>
      {open&&(
        <div style={{background:"#0b1220",border:`1px solid ${C.border}`,borderRadius:8,
          padding:"10px 12px",marginBottom:8,display:"flex",flexDirection:"column",gap:8}}>
          {[[C.jacobs,"Jacobs (2026)",jacobsNote],[C.critici,"Critici",criticiNote]].map(([col,who,note])=>(
            <div key={who} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
              <span style={{fontSize:10,padding:"2px 7px",borderRadius:4,fontWeight:700,flexShrink:0,marginTop:1,
                background:col+"22",color:col,border:`1px solid ${col}44`}}>{who}</span>
              <span style={{fontSize:11,color:C.mid,lineHeight:1.6}}>{note}</span>
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Schuifje ──────────────────────────────────────────────────────────────────
function Slider({value,min,max,step,onChange,format,sublabel}){
  const pos=((value-min)/(max-min))*100;
  return(
    <div style={{marginBottom:4}}>
      {sublabel&&<div style={{fontSize:11,color:C.dim,marginBottom:4}}>{sublabel}</div>}
      <div style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{flex:1,position:"relative",height:20,display:"flex",alignItems:"center"}}>
          <div style={{position:"absolute",left:0,right:0,height:3,background:"#1e2d42",borderRadius:3}}/>
          <div style={{position:"absolute",left:0,width:`${pos}%`,height:3,background:`linear-gradient(90deg,${C.teal},${C.acgt})`,borderRadius:3}}/>
          <input type="range" min={min} max={max} step={step} value={value}
            onChange={e=>onChange(parseFloat(e.target.value))}
            style={{position:"absolute",inset:0,width:"100%",opacity:0,cursor:"pointer",height:20,zIndex:2}}/>
          <div style={{position:"absolute",left:`calc(${pos}% - 7px)`,width:14,height:14,
            borderRadius:"50%",background:C.acgt,border:`2px solid ${C.text}`,
            boxShadow:`0 0 6px ${C.acgt}66`,pointerEvents:"none"}}/>
        </div>
        <span style={{fontSize:13,fontWeight:800,color:C.text,background:C.border,
          padding:"2px 8px",borderRadius:4,minWidth:70,textAlign:"center",flexShrink:0}}>
          {format?format(value):value}
        </span>
      </div>
    </div>
  );
}

// ── Toggle ────────────────────────────────────────────────────────────────────
function Toggle({value,onChange,on,off,color}){
  const col=color||C.teal;
  return(
    <div onClick={()=>onChange(!value)}
      style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",padding:"4px 0"}}>
      <div style={{width:36,height:20,borderRadius:10,background:value?col:"#1e2d42",
        position:"relative",flexShrink:0,transition:"background .2s"}}>
        <div style={{position:"absolute",top:2,left:value?18:2,width:16,height:16,
          borderRadius:"50%",background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px #0009"}}/>
      </div>
      <span style={{fontSize:12,color:value?C.text:C.dim,fontWeight:value?700:400,lineHeight:1.4}}>
        {value?on:off}
      </span>
    </div>
  );
}

// ── Groot kerncijfer ──────────────────────────────────────────────────────────
function BigStat({label,acgt,rcgt,acgtColor,rcgtColor,fmt:fmtProp,note}){
  const fmtFn = fmtProp || fmt;
  const diff=rcgt-acgt, dp=acgt?diff/acgt*100:0;
  return(
    <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px"}}>
      <div style={{fontSize:11,color:C.dim,fontWeight:600,marginBottom:10,textTransform:"uppercase",letterSpacing:.5}}>{label}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",alignItems:"center",gap:8}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:10,color:acgtColor||C.acgt,fontWeight:700,marginBottom:4}}>Aanwasbelasting</div>
          <div style={{fontSize:20,fontWeight:900,color:C.text,fontVariantNumeric:"tabular-nums"}}>{fmtFn(acgt)}</div>
        </div>
        <div style={{textAlign:"center",padding:"0 4px"}}>
          <div style={{fontSize:11,color:diff===0?C.dim:diff>0?rcgtColor||C.rcgt:acgtColor||C.acgt,fontWeight:800}}>
            {diff===0?"=":`${diff>0?"▲":"▼"} ${fmtFn(Math.abs(diff))}`}
          </div>
          <div style={{fontSize:10,color:C.dim,marginTop:2}}>{diff===0?"gelijk":`${dp>0?"+":""}${dp.toFixed(1)}%`}</div>
        </div>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:10,color:rcgtColor||C.rcgt,fontWeight:700,marginBottom:4}}>Winstbelasting</div>
          <div style={{fontSize:20,fontWeight:900,color:C.text,fontVariantNumeric:"tabular-nums"}}>{fmtFn(rcgt)}</div>
        </div>
      </div>
      {note&&<div style={{fontSize:10,color:C.dim,marginTop:8,lineHeight:1.5,borderTop:`1px solid ${C.border}`,paddingTop:6}}>{note}</div>}
    </div>
  );
}

// ── Hoofd app ─────────────────────────────────────────────────────────────────
export default function App(){
  const [cfg,setCfg]=useState(PRESETS.jacobs);
  const [res,setRes]=useState(null);
  const [loading,setLoading]=useState(false);
  const [dirty,setDirty]=useState(false);
  const [activePreset,setActivePreset]=useState("jacobs");
  const [hh,setHH]=useState("middle");

  const set=k=>v=>{ setCfg(c=>({...c,[k]:v})); setDirty(true); setActivePreset("custom"); };

  const applyPreset=id=>{ setCfg(PRESETS[id]); setActivePreset(id); setDirty(true); };

  // Herbereken automatisch 600ms nadat cfg verandert (debounce)
  // useRef zodat we altijd de meest recente cfg gebruiken — geen stale closure
  const cfgRef = useRef(cfg);
  useEffect(()=>{ cfgRef.current = cfg; },[cfg]);

  const run = useCallback(()=>{
    setLoading(true);
    setDirty(false);
    const snapshot = cfgRef.current;
    setTimeout(()=>{
      try{ setRes(runAll(snapshot)); }catch(e){ console.error(e); }
      setLoading(false);
    }, 30);
  },[]);

  // Eerste render
  useEffect(()=>{ run(); },[]);

  // Auto-run bij elke cfg-wijziging
  useEffect(()=>{
    const timer = setTimeout(()=>{ run(); }, 600);
    return ()=>clearTimeout(timer);
  },[cfg]);

  const d=res?.[hh];
  const ax={stroke:C.dim,fontSize:11,tickLine:false};
  const gr={strokeDasharray:"3 3",stroke:C.border,vertical:false};

  return(
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'DM Sans','Segoe UI',sans-serif"}}>

      {/* ── Header ── */}
      <div style={{borderBottom:`1px solid ${C.border}`,padding:"14px 24px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",background:"#0b1220"}}>
        <div>
          <div style={{fontSize:16,fontWeight:800}}>Box 3 Belasting Simulator</div>
          <div style={{fontSize:11,color:C.dim,marginTop:1}}>Vermogensaanwasbelasting vs Vermogenswinstbelasting · Aannames aanpasbaar</div>
        </div>

        {/* Presets */}
        <div style={{display:"flex",gap:6,alignItems:"center",marginLeft:"auto",flexWrap:"wrap"}}>
          <span style={{fontSize:11,color:C.dim}}>Aannames:</span>
          {[
            {id:"jacobs", label:"Jacobs (2026)",  sub:"budgetneutraal"},
            {id:"critici",label:"Critici",         sub:"zelfde tarief"},
          ].map(p=>(
            <button key={p.id} onClick={()=>applyPreset(p.id)} style={{
              padding:"6px 14px",borderRadius:7,cursor:"pointer",border:`1px solid`,
              borderColor:activePreset===p.id?(p.id==="jacobs"?C.jacobs:C.critici)+"88":C.border,
              background:activePreset===p.id?(p.id==="jacobs"?C.jacobs:C.critici)+"1a":"transparent",
            }}>
              <span style={{fontSize:12,fontWeight:700,color:activePreset===p.id?(p.id==="jacobs"?C.jacobs:C.critici):C.mid}}>{p.label}</span>
              <span style={{fontSize:10,color:C.dim,marginLeft:6}}>{p.sub}</span>
            </button>
          ))}
          {activePreset==="custom"&&<span style={{fontSize:11,color:C.amber,padding:"5px 10px",borderRadius:6,background:C.amber+"18",border:`1px solid ${C.amber}33`}}>✏ Eigen instellingen</span>}
          <button onClick={run} disabled={loading} style={{
            background:loading?"#1e2d42":dirty?`linear-gradient(135deg,${C.amber},${C.critici})`:`linear-gradient(135deg,${C.teal},${C.acgt})`,
            color:loading?C.dim:"#0f1520",border:"none",borderRadius:8,
            padding:"8px 20px",fontSize:13,fontWeight:800,cursor:loading?"not-allowed":"pointer",
            boxShadow:loading?"none":dirty?`0 4px 14px ${C.amber}66`:`0 4px 14px ${C.acgt}44`,
          }}>{loading?"⏳ Herberekenen…":dirty?"⟳  Vernieuwen":"✓  Up-to-date"}</button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"270px 1fr",minHeight:"calc(100vh - 57px)"}}>

        {/* ── Linkerpaneel: aannames ── */}
        <div style={{borderRight:`1px solid ${C.border}`,padding:"18px 16px",overflowY:"auto",background:"#0c111a"}}>
          <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:C.teal,fontWeight:700,marginBottom:16}}>Aannames</div>

          {/* Kleurlegenda */}
          <div style={{display:"flex",gap:12,marginBottom:20,padding:"8px 10px",background:C.card,borderRadius:8,border:`1px solid ${C.border}`}}>
            {[[C.acgt,"Aanwasbelasting"],[C.rcgt,"Winstbelasting"]].map(([col,lbl])=>(
              <div key={lbl} style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:20,height:3,background:col,borderRadius:2}}/>
                <span style={{fontSize:11,color:col,fontWeight:700}}>{lbl}</span>
              </div>
            ))}
          </div>

          {/* ── Aanname 1: Budgetneutraliteit ── */}
          <Assumption label="1 · Budgetneutraliteit"
            jacobsNote="Eerlijke vergelijking: RCGT-tarief op aandelen wordt verlaagd zodat de overheid evenveel ontvangt als onder ACGT. Anders vergelijk je appels met peren."
            criticiNote="In de politieke praktijk geldt voor beide systemen hetzelfde nominale tarief. Dat RCGT effectief minder kost is het voordeel van uitstel — dat is juist het punt.">
            <Toggle value={cfg.BUDGET_NEUTRAL}
              onChange={v=>{set("BUDGET_NEUTRAL")(v); if(!v)set("RCGT_OVERRIDE")(cfg.BASE_TAX_RATE); else set("RCGT_OVERRIDE")(null);}}
              on="Budgetneutraal — RCGT-tarief wordt automatisch berekend"
              off={`Zelfde tarief (${pct(cfg.BASE_TAX_RATE)}) voor beide systemen`}
              color={C.jacobs}/>
            {!cfg.BUDGET_NEUTRAL&&(
              <div style={{marginTop:8}}>
                <Slider sublabel="RCGT aandelentarief handmatig instellen:"
                  value={cfg.RCGT_OVERRIDE??cfg.BASE_TAX_RATE}
                  min={0.05} max={0.60} step={0.01}
                  onChange={set("RCGT_OVERRIDE")} format={pct}/>
              </div>
            )}
          </Assumption>

          {/* ── Aanname 2: Verliesverrekening ── */}
          <Assumption label="2 · Verliesverrekening"
            jacobsNote="De overheid vergoedt verliezen volledig: bij koersdaling krijgt u belasting terug. Dit is theoretisch zuiver en biedt ACGT en RCGT gelijke behandeling bij verlies."
            criticiNote="In de praktijk is verliesverrekening beperkt of vertraagd. ACGT treft u dan zwaarder: u betaalt belasting over papieren winsten, maar kunt verliezen niet altijd direct terugvorderen.">
            <Slider sublabel="100% = volledig vergoed · Lager = meer realistisch"
              value={cfg.LOSS_OFFSET} min={0} max={1} step={0.05}
              onChange={set("LOSS_OFFSET")}
              format={v=>v>=1?"Volledig (Jacobs)":v>=0.5?`${(v*100).toFixed(0)}% vergoed`:`Beperkt — ${(v*100).toFixed(0)}%`}/>
          </Assumption>

          {/* ── Aanname 3: Liquiditeit ── */}
          <Assumption label="3 · Liquiditeitskosten ACGT"
            jacobsNote="Beleggers kunnen de jaarlijkse ACGT-belasting altijd betalen zonder iets te verkopen. Geen transactiekosten of gemiste rendementen door gedwongen verkoop."
            criticiNote="Veel beleggers hebben onvoldoende cash en moeten aandelen verkopen om ACGT te betalen. Dit kost transactiekosten en verstoort de beleggingsstrategie — een reëel nadeel van ACGT.">
            <Slider sublabel="0% = geen kosten (Jacobs) · Hoger = realistischer"
              value={cfg.LIQUIDITY_COST} min={0} max={0.05} step={0.005}
              onChange={set("LIQUIDITY_COST")}
              format={v=>v===0?"Geen (Jacobs)":`${(v*100).toFixed(1)}% verkoopkosten`}/>
          </Assumption>

          {/* ── Aanname 4: Nieuwe inleg ── */}
          <Assumption label="4 · Jaarlijkse nieuwe inleg"
            jacobsNote="Het model kijkt alleen naar al bestaand vermogen. Geen nieuwe spaarbijdragen vanuit inkomen — dat maakt de wiskunde eenvoudiger en het model netter."
            criticiNote="De meeste mensen sparen maandelijks bij vanuit hun inkomen. Bij ACGT betalen zij ook belasting over nieuw geïnvesteerde euro's die meteen in waarde stijgen — dit vergroot het ACGT-nadeel.">
            <Slider sublabel="€0 = alleen bestaand vermogen (Jacobs)"
              value={cfg.ANNUAL_CONTRIBUTION} min={0} max={25000} step={500}
              onChange={set("ANNUAL_CONTRIBUTION")}
              format={v=>v===0?"Geen (Jacobs)":`€${(v/1000).toFixed(1)}k/jaar`}/>
          </Assumption>

          {/* ── Aanname 5: Erfenismotief ── */}
          <Assumption label="5 · Erfenismotief"
            jacobsNote="Het model heeft een sterk erfenismotief nodig om überhaupt vermogensopbouw te verklaren. Zonder dit motief consumeert het huishouden alles en daalt het vermogen naar nul. Jacobs kiest een hoge waarde — dit is technisch nodig voor het model, niet per se realistisch."
            criticiNote="De meeste box 3-beleggers sparen voor pensioen of onverwachte uitgaven, niet primair om te erven. Een laag erfenismotief is realistischer. Hierdoor daalt het vermogen in de grafiek — en dat laat een fundamentele beperking van het Jacobs-model zien.">
            <Slider
              sublabel="Laag = sparen voor uzelf · Hoog = vermogen nalaten"
              value={cfg.BEQUEST_WEIGHT} min={0} max={3000} step={100}
              onChange={set("BEQUEST_WEIGHT")}
              format={v=>v===0?"Geen erfenismotief":v<300?"Laag — eigen consumptie":v<800?"Gemiddeld":v<1500?"Hoog (Jacobs)":"Zeer hoog"}/>
            <div style={{fontSize:10,color:C.dim,marginTop:5,lineHeight:1.5,padding:"6px 8px",background:"#0b1220",borderRadius:6,border:`1px solid ${C.border}`}}>
              💡 Daalt het vermogen in de grafiek terwijl u dat niet verwacht? Verhoog dit naar 800–1500 of voeg jaarlijkse inleg toe (aanname 4).
            </div>
          </Assumption>

          {/* ── Marktparameters ── */}
          <div style={{borderTop:`1px solid ${C.border}`,marginTop:4,paddingTop:16}}>
            <div style={{fontSize:10,letterSpacing:2,textTransform:"uppercase",color:C.dim,fontWeight:700,marginBottom:14}}>Markt & belasting</div>
            {[
              {label:"Basisbelastingtarief",  sub:"Huidig box 3: 36%",       k:"BASE_TAX_RATE",      min:.20,max:.55,step:.01,fmt:pct},
              {label:"Aandelenrendement",     sub:"Historisch AEX ~8–9%",    k:"STOCK_RETURN_MEAN",  min:.03,max:.14,step:.005,fmt:pct1},
              {label:"Beursschommelingen",    sub:"Volatiliteit aandelen",   k:"STOCK_VOLATILITY",   min:.08,max:.32,step:.01, fmt:pct1},
              {label:"Spaarrente",            sub:"Veilig rendement",        k:"SAFE_RETURN",        min:0,  max:.07,step:.005,fmt:pct1},
              {label:"Beleggingshorizon",     sub:"",                        k:"YEARS",              min:10, max:40, step:5,   fmt:v=>`${v} jaar`},
            ].map(it=>(
              <div key={it.k} style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                  <span style={{fontSize:12,color:C.mid}}>{it.label}</span>
                  {it.sub&&<span style={{fontSize:10,color:C.dim}}>{it.sub}</span>}
                </div>
                <Slider value={cfg[it.k]} min={it.min} max={it.max} step={it.step} onChange={set(it.k)} format={it.fmt}/>
              </div>
            ))}
          </div>
        </div>

        {/* ── Rechterpaneel: grafieken ── */}
        <div style={{padding:"18px 22px",overflowY:"auto"}}>

          {/* Huishoudtype kiezer */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,marginBottom:18}}>
            {HOUSEHOLDS.map(h=>(
              <button key={h.id} onClick={()=>setHH(h.id)} style={{
                padding:"10px 8px",borderRadius:9,border:`1px solid`,cursor:"pointer",
                borderColor:hh===h.id?h.color+"99":C.border,
                background:hh===h.id?h.color+"18":"transparent",
                transition:"all .15s",
              }}>
                <div style={{fontSize:20,marginBottom:3}}>{h.icon}</div>
                <div style={{fontSize:13,fontWeight:700,color:hh===h.id?C.text:C.mid}}>{h.label}</div>
                <div style={{fontSize:12,color:hh===h.id?h.color:C.dim,marginTop:1,fontWeight:600}}>{fmt(h.start)} startkapitaal</div>
              </button>
            ))}
          </div>

          {loading&&(
            <div style={{background:C.card,borderRadius:10,border:`1px solid ${C.border}`,padding:60,textAlign:"center",color:C.dim,fontSize:14}}>
              ⏳ Simulatie loopt…
            </div>
          )}

          {d&&!loading&&(<>

            {/* ── Kerncijfers ── */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:18}}>
              <BigStat label={`Eindvermogen na ${cfg.YEARS} jaar`}
                acgt={d.eindACGT} rcgt={d.eindRCGT}/>
              <BigStat label="Totale belastingopbrengst (overheid)"
                acgt={d.totTaxACGT} rcgt={d.totTaxRCGT}
                acgtColor={C.acgt} rcgtColor={C.rcgt}/>
              <BigStat label="Aandelen in portefeuille"
                acgt={d.alphaACGT??0} rcgt={d.alphaRCGT??0}
                fmt={v=>`${(v*100).toFixed(1)}%`}
                note="RCGT belast aandelen niet jaarlijks → hogere optimale aandelenweging"/>
            </div>

            {/* ── Grafiek 1: Vermogensopbouw ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 20px",marginBottom:14}}>

              {/* Grafiek-titel + legenda */}
              <div style={{marginBottom:14}}>
                <div style={{fontSize:15,fontWeight:700,color:C.text,marginBottom:6}}>Vermogensopbouw over de tijd</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[
                    {col:C.acgt, label:"Vermogensaanwasbelasting (ACGT)", dash:false, val:d.eindACGT},
                    {col:C.rcgt, label:"Vermogenswinstbelasting (RCGT)",  dash:true,  val:d.eindRCGT},
                  ].map(item=>(
                    <div key={item.label} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",
                      background:item.col+"12",borderRadius:8,border:`1px solid ${item.col}33`}}>
                      <div style={{flexShrink:0}}>
                        <svg width="32" height="14">
                          {item.dash
                            ? <line x1="0" y1="7" x2="32" y2="7" stroke={item.col} strokeWidth="3" strokeDasharray="8 4"/>
                            : <line x1="0" y1="7" x2="32" y2="7" stroke={item.col} strokeWidth="3"/>
                          }
                        </svg>
                      </div>
                      <div>
                        <div style={{fontSize:11,color:item.col,fontWeight:700,lineHeight:1.2}}>{item.label}</div>
                        <div style={{fontSize:14,fontWeight:900,color:C.text,marginTop:2,fontVariantNumeric:"tabular-nums"}}>
                          {fmt(item.val)} <span style={{fontSize:10,color:C.dim,fontWeight:400}}>na {cfg.YEARS} jaar</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Grafiek */}
              <ResponsiveContainer width="100%" height={290}>
                <AreaChart data={d.wealth} margin={{top:8,right:16,bottom:4,left:8}}>
                  <defs>
                    <linearGradient id="gA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.acgt} stopOpacity={.22}/>
                      <stop offset="100%" stopColor={C.acgt} stopOpacity={.02}/>
                    </linearGradient>
                    <linearGradient id="gR" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.rcgt} stopOpacity={.22}/>
                      <stop offset="100%" stopColor={C.rcgt} stopOpacity={.02}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gr}/>
                  <XAxis dataKey="t" {...ax}
                    ticks={Array.from({length:Math.floor(cfg.YEARS/5)+1},(_,i)=>i*5)}
                    tickFormatter={v=>`jaar ${v}`}/>
                  <YAxis {...ax} tickFormatter={fmt} width={64}/>
                  <Tooltip content={<ChartTip/>} labelFormatter={v=>`Jaar ${v}`}/>
                  {/* Bandbreedtes */}
                  <Area type="monotone" dataKey="acgtLo" stroke="none" fill="url(#gA)" legendType="none"/>
                  <Area type="monotone" dataKey="acgtHi" stroke="none" fill="url(#gA)" legendType="none"/>
                  <Area type="monotone" dataKey="rcgtLo" stroke="none" fill="url(#gR)" legendType="none"/>
                  <Area type="monotone" dataKey="rcgtHi" stroke="none" fill="url(#gR)" legendType="none"/>
                  {/* Hoofdlijnen */}
                  <Line type="monotone" dataKey="acgt" name="Aanwasbelasting (ACGT)"
                    stroke={C.acgt} strokeWidth={3} dot={false}
                    label={props => {
                      if(props.index !== d.wealth.length-1) return null;
                      return <text x={props.x+6} y={props.y+4} fill={C.acgt} fontSize={11} fontWeight={700}>{fmt(props.value)}</text>;
                    }}/>
                  <Line type="monotone" dataKey="rcgt" name="Winstbelasting (RCGT)"
                    stroke={C.rcgt} strokeWidth={3} dot={false} strokeDasharray="8 4"
                    label={props => {
                      if(props.index !== d.wealth.length-1) return null;
                      return <text x={props.x+6} y={props.y-6} fill={C.rcgt} fontSize={11} fontWeight={700}>{fmt(props.value)}</text>;
                    }}/>
                </AreaChart>
              </ResponsiveContainer>

              {/* Actieve aannames */}
              <div style={{marginTop:10,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                <span style={{fontSize:10,color:C.dim,marginRight:2}}>Actieve aannames:</span>
                {[
                  {label:`tarief ${pct(cfg.BASE_TAX_RATE)}`,         on:true},
                  {label:`RCGT aandelen ${pct(d.tauRCGT)}${cfg.BUDGET_NEUTRAL?" (budget­neutraal)":""}`, on:true},
                  {label:`verlies­verrekening ${(cfg.LOSS_OFFSET*100).toFixed(0)}%`, on:cfg.LOSS_OFFSET<1,  src:"critici"},
                  {label:`liquiditeits­kosten ${(cfg.LIQUIDITY_COST*100).toFixed(1)}%`, on:cfg.LIQUIDITY_COST>0, src:"critici"},
                  {label:`inleg €${(cfg.ANNUAL_CONTRIBUTION/1000).toFixed(0)}k/jaar`, on:cfg.ANNUAL_CONTRIBUTION>0, src:"critici"},
                  {label:`erfenis­motief: ${cfg.BEQUEST_WEIGHT<300?"laag":cfg.BEQUEST_WEIGHT<800?"gemiddeld":cfg.BEQUEST_WEIGHT<1500?"hoog (Jacobs)":"zeer hoog"}`, on:true},
                ].filter(x=>x.on).map((item,i)=>(
                  <span key={i} style={{fontSize:10,padding:"3px 9px",borderRadius:20,
                    background:item.src==="critici"?C.critici+"1a":C.border+"55",
                    color:item.src==="critici"?C.critici:C.dim,
                    border:`1px solid ${item.src==="critici"?C.critici+"44":C.border}`}}>
                    {item.label}
                  </span>
                ))}
              </div>
            </div>

            {/* ── Grafiek 2: Belastingopbrengst ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"18px 20px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
                <div>
                  <div style={{fontSize:15,fontWeight:700,color:C.text}}>Totale belastingopbrengst (cumulatief)</div>
                  <div style={{fontSize:11,color:C.dim,marginTop:2}}>
                    Hoeveel heeft de overheid in totaal ontvangen tot en met elk jaar?
                  </div>
                </div>
                <div style={{display:"flex",gap:14,flexShrink:0}}>
                  {[[C.acgt,"Aanwasbelasting"],[C.rcgt,"Winstbelasting"]].map(([col,lbl])=>(
                    <div key={lbl} style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:22,height:3,background:col,borderRadius:2}}/>
                      <span style={{fontSize:11,color:col,fontWeight:700}}>{lbl}</span>
                    </div>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={260}>
                <AreaChart data={d.taxCum} margin={{top:4,right:8,bottom:4,left:8}}>
                  <defs>
                    <linearGradient id="gTA" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.acgt} stopOpacity={.2}/>
                      <stop offset="100%" stopColor={C.acgt} stopOpacity={.02}/>
                    </linearGradient>
                    <linearGradient id="gTR" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.rcgt} stopOpacity={.2}/>
                      <stop offset="100%" stopColor={C.rcgt} stopOpacity={.02}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gr}/>
                  <XAxis dataKey="t" {...ax}
                    tickFormatter={v=>v%5===0?`Jaar ${v}`:""}
                    label={{value:"Jaar",position:"insideBottomRight",offset:-4,fill:C.dim,fontSize:11}}/>
                  <YAxis {...ax} tickFormatter={fmt} width={60}/>
                  <Tooltip content={<ChartTip/>} labelFormatter={v=>`Jaar ${v}`}/>
                  <Area type="monotone" dataKey="acgt" name="Aanwasbelasting" stroke={C.acgt} fill="url(#gTA)" strokeWidth={3} dot={false}/>
                  <Area type="monotone" dataKey="rcgt" name="Winstbelasting"  stroke={C.rcgt} fill="url(#gTR)" strokeWidth={3} dot={false} strokeDasharray="8 4"/>
                </AreaChart>
              </ResponsiveContainer>

              {/* Uitleg budgetneutraliteit */}
              <div style={{marginTop:10,padding:"10px 12px",background:"#0b1220",borderRadius:7,border:`1px solid ${C.border}`,fontSize:11,color:C.mid,lineHeight:1.6}}>
                {cfg.BUDGET_NEUTRAL
                  ? <><span style={{color:C.jacobs,fontWeight:700}}>Jacobs-aanname actief:</span> het RCGT-tarief op aandelen is verlaagd naar <strong style={{color:C.text}}>{pct(d.tauRCGT)}</strong> zodat de verwachte belastingopbrengst gelijk is aan die van ACGT ({pct(cfg.BASE_TAX_RATE)}). De lijnen eindigen daardoor op vergelijkbaar niveau.</>
                  : <><span style={{color:C.critici,fontWeight:700}}>Critici-aanname actief:</span> beide systemen hanteren hetzelfde tarief van <strong style={{color:C.text}}>{pct(cfg.RCGT_OVERRIDE??cfg.BASE_TAX_RATE)}</strong>. RCGT ontvangt minder belasting door het uitsteleffect — dat is zichtbaar als de rode lijn lager uitkomt.</>
                }
              </div>
            </div>

          </>)}
        </div>
      </div>
      <style>{`input[type=range]::-webkit-slider-thumb{width:1px;height:1px;opacity:0}`}</style>
    </div>
  );
}
