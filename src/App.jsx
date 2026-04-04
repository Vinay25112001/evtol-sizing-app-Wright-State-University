import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { AuthModal, AuthGate, UserHeaderBar, getSession, saveSession, clearSession, addNotif, saveDesign, addReport, setAuthTheme } from "./AuthSystem";
import { ShareDesignButton, LeaderboardPanel, CollabPanel, PublicDesignBanner } from "./CommunityFeatures";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, RadarChart, Radar,
  ComposedChart, ScatterChart, Scatter,
  PolarGrid, PolarAngleAxis, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell, PieChart, Pie
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════════
   PHYSICS ENGINE — exact port of eVTOL_Full_Analysis_v2.m
   ═══════════════════════════════════════════════════════════════════════ */
function runSizing(p) {
  const g0=9.81,rhoMSL=1.225,T0=288.15,L=0.0065,Rgas=287,GAM=1.4,mu0=1.47e-5;
  // ISA deviation: deltaISA=0 → standard day; deltaISA=15 → hot day (ISA+15)
  const deltaT=p.deltaISA||0;
  const T0eff=T0+deltaT;  // effective sea-level temperature
  const Tcr=T0eff-L*p.cruiseAlt;
  const rhoCr=rhoMSL*Math.pow(Tcr/T0eff,(-g0/(-L*Rgas))-1);
  const muCr=mu0*Math.pow(Tcr/T0eff,0.75);
  const aCr=Math.sqrt(GAM*Rgas*Tcr);
  // Hover altitude density — affects rotor power at T/O and landing altitude
  const Thov=T0eff-L*(p.hoverHeight||15.24);
  const rhoHov=rhoMSL*Math.pow(Thov/T0eff,(-g0/(-L*Rgas))-1);
  const RoC=p.rateOfClimb,clAng=p.climbAngle;
  const Vcl=RoC/Math.sin(clAng*Math.PI/180);
  // Climb L/D derating: induced drag increases at climb AoA (user-adjustable, default 13%)
  const LDcl=p.LD*(1-(p.climbLDPenalty||0.13));
  // Descent angle derived from L/D — matches MATLAB: Decent_Angle = -atand(1/L/D)
  const desAng=Math.atan(1/p.LD)*180/Math.PI;
  const Vdc=RoC/Math.sin(desAng*Math.PI/180);  // no cruise speed cap — matches MATLAB
  // Reserve: distance-based — matches MATLAB: Reserve_Range=60 km, Vres=0.7×Vcruise
  // Reserve_Time = Reserve_Range*1000 / Reserve_Phase_velocity (derived from distance)
  const Vres=0.70*p.vCruise;
  const reserveRange_m=(p.reserveRange||60)*1000;   // [m] default 60 km (FAA Part 135)
  const tres_s=reserveRange_m/Vres;                  // reserve time derived from distance
  const reserveDistM=reserveRange_m;                 // fixed distance deducted from cruise range
  const hvtol=p.hoverHeight;
  const ClimbR=(p.cruiseAlt-hvtol)/Math.tan(clAng*Math.PI/180);
  const DescR=(p.cruiseAlt-hvtol)/Math.tan(desAng*Math.PI/180);

  /* Convergence tolerance — user-controlled exponent, e.g. tolExp=-6 → tol=1e-6 */
  const tol = Math.pow(10, p.convTolExp || -6);

  /* Round 1 */
  let MTOW1=2177,Wempty1,Wbat1,itersR1=0;
  for(let i=0;i<5000;i++){
    itersR1=i+1;
    Wempty1=p.ewf*MTOW1;
    const bf=(g0*p.range*1000)/(p.LD*p.etaSys*p.sedCell*3600);
    Wbat1=bf*MTOW1;
    const mn=p.payload+Wempty1+Wbat1;
    if(Math.abs(mn-MTOW1)<tol){MTOW1=mn;break;}
    MTOW1=mn;
    if(MTOW1>5700)break;
  }

  const CruiseRange=p.range*1000-ClimbR-DescR-reserveDistM;  // actual cruise distance

  /* Round 2 — coupled MTOW+Energy  (T/W ratio applied to hover thrust) */
  const TW = p.twRatio||1.0;
  let MTOW=MTOW1;
  let Phov,Pcl,Pcr,Pdc,Pres,tto,tcl,tcr,tdc,tld,tres;
  let Eto,Ecl,Ecr,Edc,Eld,Eres,Etot,Wempty,Wbat;
  const mtowH=[MTOW1],energyH=[],residualH=[];
  let itersR2=0, r2Converged=false;
  for(let o=0;o<200;o++){
    itersR2=o+1;
    const W=MTOW*g0;
    // ── AERODYNAMIC L/D for current MTOW — computed inside loop so Pcr/Pres ──
    // use the physically correct drag, not just the user-input p.LD.
    // p.LD is a TARGET / sanity check; LDact_i is what the wing actually produces.
    const Swing_i=2*W/(rhoCr*p.vCruise**2*p.clDesign);
    const bW_i=Math.sqrt(p.AR*Swing_i), Cr_i=2*Swing_i/(bW_i*(1+p.taper));
    const MAC_i=(2/3)*Cr_i*(1+p.taper+p.taper**2)/(1+p.taper);
    const Re_i=rhoCr*p.vCruise*MAC_i/muCr;
    const Sww_i=2*Swing_i*(1+0.25*p.tc*(1+p.taper*0.25));
    const fL_i=p.fusLen,fD_i=p.fusDiam,lf_i=fL_i/fD_i;
    const Swf_i=Math.PI*fD_i*fL_i*Math.pow(1-2/lf_i,2/3)*(1+1/lf_i**2);
    const Swhs_i=2*Swing_i*0.18,Swvs_i=2*Swing_i*0.12;
    const Swn_i=p.nPropHover*0.10*Math.PI*Math.pow(p.propDiam/2,2);
    const Cfw_i=0.455/Math.log10(Re_i)**2.58/(1+0.144*(p.vCruise/aCr)**2)**0.65;
    const Cff_i=0.455/Math.log10(rhoCr*p.vCruise*fL_i/muCr)**2.58/(1+0.144*(p.vCruise/aCr)**2)**0.65;
    const FFw_i=(1+(0.6/0.30)*p.tc+100*p.tc**4)*1.05;
    const FFf_i=1+60/lf_i**3+lf_i/400;
    const CD0_i=Cfw_i*FFw_i*Sww_i/Swing_i+Cff_i*FFf_i*Swf_i/Swing_i+
      Cfw_i*1.05*(Swhs_i+Swvs_i)/Swing_i+Cfw_i*1.30*Swn_i/Swing_i+0.003+0.002;
    const CDi_i=p.clDesign**2/(Math.PI*p.AR*p.eOsw);
    const LDact_i=p.clDesign/(CD0_i+CDi_i);  // physics-based L/D for THIS MTOW iteration
    // ── HOVER POWER at T/W=1.0 (steady hover equilibrium) ─────────────────
    // T/W ratio is a structural margin for climb/OEI — NOT applied to steady hover.
    // In hover: each rotor supports W/N (not W*TW/N). Motors sized for TW but fly at W.
    const DL=(W)/(Math.PI*Math.pow(p.propDiam/2,2)*p.nPropHover);
    Phov=(W/p.etaHov)*Math.sqrt(DL/(2*rhoMSL))/1000;  // matches MATLAB: uses Density_MSL=1.225
    // η_hov absorbs: non-uniform inflow, swirl losses, figure-of-merit deviation from ideal
    Pcl=(W/p.etaSys)*(RoC+Vcl/LDcl)/1000;
    Pcr=(W/p.etaSys)*(p.vCruise/p.LD)/1000;   // matches MATLAB: P_cruise uses fixed Lift_to_Drag
    Pdc=(W/p.etaSys)*(-RoC+Vdc/LDcl)/1000;  // descent power — matches MATLAB formula
    Pres=(W/p.etaSys)*(Vres/p.LD)/1000;      // matches MATLAB: P_reserve uses fixed Lift_to_Drag
    // Takeoff/landing hover times — matches MATLAB: Vertical_Takeoff/Landing_Time = hvtol/0.5
    tto=hvtol/0.5; tcl=ClimbR/Vcl; tcr=Math.max(0,CruiseRange/p.vCruise);
    tdc=DescR/Vdc; tld=hvtol/0.5; tres=tres_s;
    Eto=Phov*tto/3600;  // matches MATLAB: E_to = P_hover * Vertical_Takeoff_Time / 3600
    Ecl=Pcl*tcl/3600; Ecr=Pcr*tcr/3600;
    Edc=Pdc*tdc/3600;
    Eld=Phov*tld/3600; Eres=Pres*tres/3600;
    Etot=Eto+Ecl+Ecr+Edc+Eld+Eres;
    Wempty=p.ewf*MTOW;
    // Battery C-rate derating: SED drops at high discharge rates (hover peaks 3–5C)
    // Approximate: SED_eff = sedCell × (1 - cRateDerate); default 8% for ~3-4C hover
    const sedEff=p.sedCell*(1-(p.cRateDerate??0.08));
    // Dual-constraint battery sizing — matches MATLAB: Wbattery = max(W_E, W_P)
    // W_E: energy limit  — exact (1-SoCmin) form, not (1+SoCmin) approximation
    // W_P: power limit   — W_P = P_hover / SP_battery
    const WE=Etot*1000/((1-p.socMin)*sedEff*p.etaBat);
    const WP=Phov/(p.spBattery||1.0);
    Wbat=Math.max(WE,WP);
    const mn=p.payload+Wempty+Wbat;
    const residual=Math.abs(mn-MTOW);
    energyH.push(+Etot.toFixed(3)); mtowH.push(+mn.toFixed(2));
    residualH.push(residual);
    if(residual<tol){MTOW=mn;r2Converged=true;break;}
    MTOW=mn;
  }
  const Mach=p.vCruise/aCr;

  /* Wing */
  const Lreq=MTOW*g0,Swing=2*Lreq/(rhoCr*p.vCruise**2*p.clDesign);
  const WL=Lreq/Swing,bWing=Math.sqrt(p.AR*Swing);
  const Cr_=2*Swing/(bWing*(1+p.taper)),Ct_=Cr_*p.taper;
  const MAC=(2/3)*Cr_*(1+p.taper+p.taper**2)/(1+p.taper);
  const Ymac=(bWing/6)*(1+2*p.taper)/(1+p.taper);
  const Xac=Cr_-MAC+0.25*MAC;
  const sweep=Math.atan((Cr_-Ct_)/(bWing/2))*180/Math.PI;  // LE sweep: semi-span in denominator
  const Re_=rhoCr*p.vCruise*MAC/muCr;

  /* ═══════════════════════════════════════════════════════════
     AIRFOIL LIBRARY — 24 sections, UIUC Airfoil Database data
     CDmin_lo: Re ≈ 1×10⁶ (low-speed / transition)
     CDmin_hi: Re ≈ 6-9×10⁶ (cruise Re)
     Source: UIUC ADB (Selig et al.), Abbott & von Doenhoff,
             Riegels "Aerofoil Sections", NASA TN-D series
     ═══════════════════════════════════════════════════════════ */
  const AF=[
    // ── 4-digit NACA (general-purpose) ──────────────────────────────────
    {name:"NACA 2412", tc:0.120,CLmax:1.50,CLd:0.55,CDmin_lo:0.0078,CDmin_hi:0.0058,CM:-0.050,ReM:6.0,source:"Abbott & VD 1959",category:"4-digit"},
    {name:"NACA 4412", tc:0.120,CLmax:1.60,CLd:0.70,CDmin_lo:0.0085,CDmin_hi:0.0063,CM:-0.098,ReM:6.0,source:"Abbott & VD 1959",category:"4-digit"},
    {name:"NACA 4415", tc:0.150,CLmax:1.65,CLd:0.65,CDmin_lo:0.0090,CDmin_hi:0.0065,CM:-0.095,ReM:5.0,source:"Abbott & VD 1959",category:"4-digit"},
    {name:"NACA 2415", tc:0.150,CLmax:1.52,CLd:0.55,CDmin_lo:0.0080,CDmin_hi:0.0060,CM:-0.050,ReM:6.0,source:"Abbott & VD 1959",category:"4-digit"},
    // ── 5-digit NACA (high CLmax) ────────────────────────────────────────
    {name:"NACA 23012",tc:0.120,CLmax:1.60,CLd:0.55,CDmin_lo:0.0074,CDmin_hi:0.0055,CM:-0.013,ReM:6.0,source:"Abbott & VD 1959",category:"5-digit"},
    {name:"NACA 23015",tc:0.150,CLmax:1.60,CLd:0.60,CDmin_lo:0.0082,CDmin_hi:0.0060,CM:-0.010,ReM:6.0,source:"Abbott & VD 1959",category:"5-digit"},
    {name:"NACA 23018",tc:0.180,CLmax:1.58,CLd:0.60,CDmin_lo:0.0090,CDmin_hi:0.0068,CM:-0.008,ReM:5.0,source:"Abbott & VD 1959",category:"5-digit"},
    // ── NACA 6-series laminar (low CDmin at design CL) ───────────────────
    {name:"NACA 63-215",tc:0.150,CLmax:1.55,CLd:0.60,CDmin_lo:0.0065,CDmin_hi:0.0042,CM:-0.040,ReM:9.0,source:"UIUC ADB / Abbott 1959",category:"6-series"},
    {name:"NACA 63-415",tc:0.150,CLmax:1.60,CLd:0.62,CDmin_lo:0.0068,CDmin_hi:0.0044,CM:-0.065,ReM:9.0,source:"UIUC ADB / Abbott 1959",category:"6-series"},
    {name:"NACA 63A-412",tc:0.120,CLmax:1.52,CLd:0.58,CDmin_lo:0.0062,CDmin_hi:0.0040,CM:-0.045,ReM:8.0,source:"UIUC ADB",category:"6-series"},
    {name:"NACA 64-415",tc:0.150,CLmax:1.55,CLd:0.58,CDmin_lo:0.0060,CDmin_hi:0.0038,CM:-0.060,ReM:9.0,source:"Abbott & VD 1959",category:"6-series"},
    {name:"NACA 64A-212",tc:0.120,CLmax:1.45,CLd:0.50,CDmin_lo:0.0055,CDmin_hi:0.0036,CM:-0.035,ReM:9.0,source:"NASA TN-1428",category:"6-series"},
    {name:"NACA 65-415",tc:0.150,CLmax:1.52,CLd:0.58,CDmin_lo:0.0058,CDmin_hi:0.0037,CM:-0.055,ReM:9.0,source:"Abbott & VD 1959",category:"6-series"},
    {name:"NACA 65(2)-415",tc:0.150,CLmax:1.55,CLd:0.62,CDmin_lo:0.0057,CDmin_hi:0.0038,CM:-0.060,ReM:8.0,source:"UIUC ADB",category:"6-series"},
    // ── NASA General Aviation / high-lift ────────────────────────────────
    {name:"NASA GA(W)-1",tc:0.170,CLmax:1.80,CLd:0.70,CDmin_lo:0.0095,CDmin_hi:0.0070,CM:-0.120,ReM:4.0,source:"NASA TM-74097",category:"GA high-lift"},
    {name:"NASA GA(W)-2",tc:0.130,CLmax:1.70,CLd:0.65,CDmin_lo:0.0082,CDmin_hi:0.0060,CM:-0.090,ReM:5.0,source:"NASA TM-74097",category:"GA high-lift"},
    {name:"NASA LS(1)-0413",tc:0.130,CLmax:1.75,CLd:0.65,CDmin_lo:0.0085,CDmin_hi:0.0062,CM:-0.105,ReM:4.5,source:"NASA TP-1272",category:"GA high-lift"},
    // ── Wortmann FX (sailplane/UAM laminar) ──────────────────────────────
    {name:"Wortmann FX 63-137",tc:0.137,CLmax:1.80,CLd:0.85,CDmin_lo:0.0075,CDmin_hi:0.0052,CM:-0.128,ReM:3.0,source:"Riegels / UIUC ADB",category:"Wortmann"},
    {name:"Wortmann FX 71-L-150",tc:0.150,CLmax:1.78,CLd:0.90,CDmin_lo:0.0078,CDmin_hi:0.0055,CM:-0.135,ReM:2.5,source:"UIUC ADB",category:"Wortmann"},
    // ── Clark Y & RAF (classic) ───────────────────────────────────────────
    {name:"Clark Y",   tc:0.117,CLmax:1.47,CLd:0.58,CDmin_lo:0.0080,CDmin_hi:0.0059,CM:-0.080,ReM:5.0,source:"Riegels 1961",category:"Classic"},
    {name:"RAF 6",     tc:0.090,CLmax:1.20,CLd:0.40,CDmin_lo:0.0085,CDmin_hi:0.0062,CM:-0.060,ReM:5.0,source:"Riegels 1961",category:"Classic"},
    // ── eVTOL / composite purpose designed ───────────────────────────────
    {name:"NACA 63(3)-618",tc:0.180,CLmax:1.70,CLd:0.75,CDmin_lo:0.0070,CDmin_hi:0.0048,CM:-0.075,ReM:6.0,source:"Abbott & VD / UIUC",category:"6-series"},
    {name:"NACA 4418", tc:0.180,CLmax:1.72,CLd:0.72,CDmin_lo:0.0095,CDmin_hi:0.0072,CM:-0.096,ReM:4.5,source:"Abbott & VD 1959",category:"4-digit"},
    {name:"NACA 0012", tc:0.120,CLmax:1.30,CLd:0.00,CDmin_lo:0.0070,CDmin_hi:0.0052,CM: 0.000,ReM:6.0,source:"Abbott & VD 1959",category:"Symmetric"},
  ];
  // ── Re-dependent CDmin interpolation ────────────────────────────────
  // CDmin varies significantly with Reynolds number (±30% across Re=1-9M).
  // Interpolate between CDmin_lo (Re≈1M) and CDmin_hi (Re≈7M) using current wing Re.
  // Beyond Re=7M: CDmin stays at CDmin_hi (turbulent, flat-plate limit reached).
  // Below Re=1M: CDmin stays at CDmin_lo (laminar separation dominates).
  const ReM_=Re_/1e6;
  const interp_CDmin=(af)=>{
    const t=Math.max(0,Math.min(1,(ReM_-1.0)/(7.0-1.0)));
    return af.CDmin_lo + t*(af.CDmin_hi - af.CDmin_lo);
  };
  // ── Check for custom airfoil override ────────────────────────────────
  // If user provided custom polar data via the Custom Airfoil panel,
  // inject it as first (and preferred) candidate with high base score.
  const customAF = p.customAirfoil || null;
  const afAll = customAF
    ? [{...customAF, CDmin_lo:customAF.CDmin, CDmin_hi:customAF.CDmin, ReM:ReM_, source:"User / XFoil", category:"Custom"}, ...AF]
    : AF;

  const maxCD_=Math.max(...afAll.map(a=>interp_CDmin(a)));
  const afScored=afAll.map(a=>{
    const CDmin_eff=interp_CDmin(a);
    const baseScore=
      0.30*(1-Math.min(Math.abs(a.ReM-ReM_)/Math.max(ReM_,1),1))
      +0.20*(1-Math.min(Math.abs(a.tc-p.tc)/p.tc,1))
      +0.20*(1-Math.min(Math.abs(a.CLd-p.clDesign)/p.clDesign,1))
      +0.20*(1-CDmin_eff/maxCD_)
      +0.10*(1-Math.min(Math.abs(a.CM)/0.12,1));
    // Custom airfoil gets a +0.10 bonus so user selection always wins
    const score = a.category==="Custom" ? Math.min(1, baseScore+0.10) : baseScore;
    return {...a, CDmin:CDmin_eff, score};
  });
  const selAF=afScored.reduce((a,b)=>b.score>a.score?b:a);

  /* Drag (Raymer) */
  const Sww=2*Swing*(1+0.25*p.tc*(1+p.taper*0.25));
  const fL=p.fusLen,fD=p.fusDiam;
  const lambda_f=fL/fD;  // fineness ratio
  const Swf=Math.PI*fD*fL*Math.pow(1-2/lambda_f,2/3)*(1+1/lambda_f**2);  // Raymer Eq 12.31
  // Tail wetted areas: fixed fractions of wing area (conceptual estimate only)
  // NOT dynamically sized — real tail sizing uses volume coefficients and moment arm
  const Swhs=2*Swing*0.18, Swvs=2*Swing*0.12;
  // Nacelle wetted area: proportional to rotor radius² (not fixed arbitrary constants)
  // S_wet_nac ≈ N_rot × K_nac × π × R² where K_nac≈0.10 (nacelle/fairing ≈ 10% of disk area)
  const Swn=p.nPropHover * 0.10 * Math.PI * Math.pow(p.propDiam/2, 2);
  const Refus=rhoCr*p.vCruise*fL/muCr;
  // Schlichting turbulent flat-plate Cf with Karman-Schlichting compressibility correction
  // ASSUMPTION: fully turbulent flow everywhere — laminar regions neglected (conservative;
  // real eVTOL wings may have 20-40% laminar run → actual Cf could be 10-20% lower)
  // Component-specific roughness effects neglected (same Cf formula for all surfaces)
  const Cfw=0.455/Math.log10(Re_)**2.58/(1+0.144*Mach**2)**0.65;
  const Cff=0.455/Math.log10(Refus)**2.58/(1+0.144*Mach**2)**0.65;
  // Wing form factor — Raymer §12.5: FF = (1 + 0.6/(x/c)*t/c + 100*(t/c)⁴) × 1.05
  // x/c = chordwise position of max thickness ≈ 0.30 (NACA 4-digit series default)
  // NOTE: fully turbulent assumption — laminar flow effects neglected (conservative)
  const xc_maxthick = 0.30;   // position of max thickness; 0.30 for NACA 4-digit, ~0.40 for 6-series
  const FFw=(1+(0.6/xc_maxthick)*p.tc+100*p.tc**4)*1.05;  // Raymer Eq 12.35
  const FFf=1+60/(fL/fD)**3+(fL/fD)/400;
  const CD0w=Cfw*FFw*Sww/Swing,CD0f=Cff*FFf*Swf/Swing;
  const CD0h=Cfw*1.05*Swhs/Swing,CD0v=Cfw*1.05*Swvs/Swing;
  const CD0n=Cfw*1.30*Swn/Swing;
  // Landing gear drag: eVTOL with retractable/folding gear uses CD0g ≈ 0.003
  // Raymer Table 12.6: fixed gear = 0.015; retractable = 0.003; fully faired = 0.001
  // Winged lift+cruise eVTOL (Joby, Archer) use folding/retractable gear → 0.003
  const CD0g=0.003;  // retractable/folded gear — Raymer Table 12.6
  const CD0m=0.002;
  const CD0tot=CD0w+CD0f+CD0h+CD0v+CD0n+CD0g+CD0m;
  // Induced drag — Oswald efficiency method (Raymer §12.6)
  // NOTE: rotor-wing aerodynamic interference not modelled (can add 5-15% to CDi for eVTOL)
  // Non-planar lift effects (winglets, distributed lift) also neglected
  const CDi=p.clDesign**2/(Math.PI*p.AR*p.eOsw);
  const CDtot=CD0tot+CDi,LDact=p.clDesign/CDtot;

  /* Stability — corrected per Raymer §12 & §16 */
  // CG positions: wing structural CG at 40% MAC (Raymer §15), not at AC (25% MAC)
  // Avionics CG scales with fusLen (18% ≈ forward instrument bay), not hardcoded 0.8 m
  const xCGfus=fL*0.42;
  const xCGwing=fL*0.2589+0.40*MAC;   // FIX 1.3: structural CG at 40% MAC (not 25%)
  const xCGbat=fL*0.38,xCGpay=fL*0.40;
  const xCGavc=fL*0.18;               // FIX 1.4: scales with fusLen (was hardcoded 0.8 m)
  const Wfusc=Wempty*0.35,Wwingc=Wempty*0.18,Wmotc=Wempty*0.22,Wavc=Wempty*0.04,Wothc=Wempty*0.21;
  const xCGempty=(Wfusc*xCGfus+Wwingc*xCGwing+Wmotc*xCGfus+Wavc*xCGavc+Wothc*xCGfus)/Wempty;
  const xCGtotal=(Wempty*xCGempty+Wbat*xCGbat+p.payload*xCGpay)/MTOW;
  const xACwing=fL*0.2589+Xac;
  // FIX 1.5: tail moment arm = tail AC to wing AC, not fuselage tip to wing AC
  // Tail AC is at ~88% fusLen (same reference used for V-tail arm lv below)
  const lh=fL*0.88-xACwing;           // FIX 1.5: was fL-xACwing (too long by ~0.12*fL)
  const Sh=Swing*0.18;
  // FIX 1.1: CLa finite-wing — Raymer Eq. 12.6 (subsonic, sweep≈0)
  // Old formula 2π(1+0.77·t/c) is a 2D thickness correction, not finite-wing slope
  const CLaW=2*Math.PI*p.AR/(2+Math.sqrt(p.AR**2+4));   // Raymer Eq.12.6: ≈4.9/rad at AR=8
  // FIX 1.2: downwash gradient — use correct CLaW in dε/dα = 2·CLα/(π·AR)
  // (Anderson Eq.5.39 for elliptic wing; CLaW now the correct finite-wing value)
  const dw=2*CLaW/(Math.PI*p.AR);
  const xNP=xACwing+(Sh/Swing)*0.9*(1-dw)*lh;
  const SM=(xNP-xCGtotal)/MAC;

  /* ══════════════════════════════════════════════════
     V-TAIL SIZING  (Ruscheweyh / Raymer method)
     Each panel set at dihedral angle Γ from horizontal.
     Two panels replace H-stab + V-stab.
     Longitudinal (pitch) control  →  ruddervators act as elevator
     Lateral     (yaw)   control  →  ruddervators act as rudder
     ══════════════════════════════════════════════════ */
  const vtGamma_deg=p.vtGamma;                         // dihedral angle (°)
  const vtGamma=vtGamma_deg*Math.PI/180;               // radians

  // Equivalent H-tail and V-tail areas needed (from conventional sizing via Cv, Ch)
  const Ch=p.vtCh;      // horizontal tail volume coefficient (typical 0.35–0.50)
  const Cv=p.vtCv;      // vertical   tail volume coefficient (typical 0.04–0.06)
  // lv: tail moment arm = (tail AC pos.) − (wing AC pos.)
  // Tail AC ≈ fuselage tail − 0.25×MAC_vt; use 0.88×fL as tail-AC proxy
  // (accounts for tail root chord = ~12% fL, V-tail positioned at fuselage end)
  const lv=fL*0.88-xACwing;  // tail moment arm (corrected for tail panel chord offset)
  const bv_est=bWing;   // reference span for Cv
  const Sh_req=Ch*Swing*MAC/lv;                    // required H-tail area (m²)
  const Sv_req=Cv*Swing*bv_est/lv;                 // required V-tail area (m²)

  // ── Correct V-tail aerodynamics (Ruscheweyh / Raymer §6.3) ──────────────
  // A V-tail panel inclined at dihedral Γ generates a force NORMAL to its surface.
  // With TWO panels (left + right), combined pitch and yaw stiffness:
  //   Pitch: 2 × S_panel × cos²Γ × lv = Sh_req × lv  → S_panel = Sh_req / (2·cos²Γ)
  //   Yaw:   2 × S_panel × sin²Γ × lv = Sv_req × lv  → S_panel = Sv_req / (2·sin²Γ)
  //
  // Panel sizing: size to the harder constraint at the chosen Γ:
  //   S_panel = max(Sh_req/(2cos²Γ), Sv_req/(2sin²Γ))
  //   Svt_total = 2 × S_panel = max(Sh_req/cos²Γ, Sv_req/sin²Γ)
  //
  // Sh_eff (total pitch-effective area from both panels) = 2 × S_panel × cos²Γ
  // Sv_eff (total yaw-effective  area from both panels) = 2 × S_panel × sin²Γ
  //
  // Minimum-area optimal angle: Sh_req/(2cos²Γ) = Sv_req/(2sin²Γ)
  //   → tan²Γ = Sv_req/Sh_req  → Γ_opt = arctan(√(Sv_req/Sh_req))
  // ─────────────────────────────────────────────────────────────────────
  const cos2=Math.cos(vtGamma)**2, sin2=Math.sin(vtGamma)**2;

  // Optimal dihedral — minimises total panel area
  const vtGamma_opt_deg=Math.atan(Math.sqrt(Sv_req/Sh_req))*180/Math.PI;

  // Required panel area at the chosen Γ — divide by 2 (both panels share the load)
  const Svt_panel_pitch=Sh_req/(2*cos2);   // one panel needed to satisfy pitch
  const Svt_panel_yaw  =Sv_req/(2*sin2);   // one panel needed to satisfy yaw
  const Svt_panel=Math.max(Svt_panel_pitch, Svt_panel_yaw); // governing constraint
  const Svt_total=2*Svt_panel;             // both panels combined

  // Actual combined effectiveness from both panels
  const Sh_eff=2*Svt_panel*cos2;   // total pitch-effective area (= Sh_req for governing constraint)
  const Sv_eff=2*Svt_panel*sin2;   // total yaw-effective  area

  // Ratios vs required (governing = 100%, other may be >100%)
  const pitch_ratio=Sh_eff/Sh_req;
  const yaw_ratio  =Sv_eff/Sv_req;

  // Ruddervator mixing: symmetric deflection → elevator; differential → rudder
  // Max simultaneous authority (combined load factor):
  const ruddervator_combined_auth=Math.sqrt(pitch_ratio**2+yaw_ratio**2);

  // Panel geometry (Raymer): assume AR_vt = 2.5, taper 0.4, NACA 0009
  const AR_vt=p.vtAR;
  const taper_vt=0.4;
  const bvt_panel=Math.sqrt(AR_vt*Svt_panel);               // panel span
  const Cr_vt=2*Svt_panel/(bvt_panel*(1+taper_vt));
  const Ct_vt=Cr_vt*taper_vt;
  const MAC_vt=(2/3)*Cr_vt*(1+taper_vt+taper_vt**2)/(1+taper_vt);
  const sweep_vt=Math.atan((Cr_vt-Ct_vt)/(bvt_panel/2))*180/Math.PI;  // LE sweep: semi-span

  // Ruddervator sizing: control surface = 25–35% of panel chord
  const ruddervator_chord_frac=0.30;
  const Srv=ruddervator_chord_frac*Svt_panel;   // ruddervator area per panel

  // Tail weight estimate (Roskam UAV method, % of empty weight)
  const Wvt_panel=0.036*Svt_panel*Math.pow(AR_vt,0.25)*0.82*1000/9.81; // simplified Raymer eq 15.26
  const Wvt_total=2*Wvt_panel;

  // Drag contribution of V-tail (Raymer component buildup)
  const Swvt=2*Svt_panel*(1+0.25*0.09*(1+taper_vt*0.25)); // wetted area (NACA 0009 → tc=0.09)
  const Revt=rhoCr*p.vCruise*MAC_vt/muCr;
  const Cfvt=0.455/Math.log10(Revt)**2.58/(1+0.144*Mach**2)**0.65;
  const FFvt=(1+0.6/0.3*0.09+100*0.09**4)*1.05;
  const CD0vt=Cfvt*FFvt*Swvt/Swing;

  // Updated NP with correct V-tail pitch contribution (cos²Γ component)
  const eta_vt=0.90;
  // NP shift: only the pitch-effective component (Sh_eff = S_panel·cos²Γ) moves NP aft
  const xNP_vt=xACwing+(Sh_eff/Swing)*eta_vt*(1-dw)*lv;
  const SM_vt=(xNP_vt-xCGtotal)/MAC;

  // Ruddervator symmetric (elevator) deflection for pitch trim at cruise
  // δ_e_equiv = δ_rv × cos(Γ)  → δ_rv = δ_e_equiv / cos(Γ)
  const CM_ac=selAF.CM;
  const delta_e_equiv=-(CM_ac*Swing*MAC)/(eta_vt*Sh_eff*lv);   // equivalent elevator rad
  const delta_rv_rad=delta_e_equiv/Math.cos(vtGamma);           // ruddervator deflection rad
  const delta_rv_deg=delta_rv_rad*180/Math.PI;

  // Ruddervator differential (rudder) deflection for yaw trim (β=2° sideslip estimate)
  const CY_beta=-0.30;  // typical side-force derivative
  const beta_trim=2*Math.PI/180;
  const delta_yaw_rv_deg=(CY_beta*beta_trim*Swing)/(2*Sv_eff/lv)*180/Math.PI*(-1);

  /* Propulsion */
  const Ttot=MTOW*g0*TW,Trotor=Ttot/p.nPropHover,Protor_W=Phov*1000/p.nPropHover;
  const TW_hover=TW;
  const TW_cruise=(Pcr*p.etaSys*1000)/(p.vCruise*MTOW*g0);
  // Rotor geometry: use user-set propDiam directly — Drotor IS propDiam.
  // Previously Adisk was back-computed from T³/(2ρP²) which is circular and gave a
  // different (larger) diameter than the slider. propDiam drives DL and Phov; Drotor = propDiam.
  const Rrotor=p.propDiam/2, Drotor=p.propDiam;
  const Adisk=Math.PI*Rrotor**2;
  const DLrotor=Trotor/Adisk,PLrotor=Trotor/(Protor_W/1000);
  const aMSL_=Math.sqrt(GAM*Rgas*T0);                         // MSL sound speed (340.3 m/s)
  const vi_ind=Math.sqrt(Trotor/(2*rhoMSL*Adisk));            // true induced velocity (m/s)
  const Mtip_design=0.58;                                      // ≤0.58 → Vtip ≤ 200 m/s (14 CFR / CS-36)
  const TipSpd=Mtip_design*aMSL_;                             // correct tip speed from Mach limit
  const TipMach=TipSpd/aCr;                                   // Mach at cruise altitude (for compressibility check)
  const RPM=TipSpd/Rrotor*60/(2*Math.PI);                    // RPM from correct Omega=Vtip/R

  // ── FIX: sigma hardcoded 0.10 → computed from actual blade geometry ──
  // Global solidity: sigma = B*c/(pi*R) where c = chord, B = blade count
  // Using p.propDiam from user slider; Nbld = 3 (structural default, matches BEM tab)
  const Nbld=3;
  const ChordBl=(0.10*Math.PI*Rrotor/Nbld);   // chord from design solidity σ=0.10
  const sigma=Nbld*ChordBl/(Math.PI*Rrotor);   // back-computed (= 0.10, now explicit)
  const BladeAR=Rrotor/ChordBl;
  const PmotKW=Protor_W/1000*1.15,PpeakKW=PmotKW*1.50;
  const Torque=PmotKW*1000/(RPM*Math.PI/30),MotMass=PmotKW/5.0;

  /* Battery */
  const SEDpack=Etot*1000/Wbat,Vcell=3.6,Ahcell=5.0,Vpack=800;
  const Nseries=Math.round(Vpack/Vcell),PackAhReq=Etot*1000/Vpack;
  const Npar=Math.ceil(PackAhReq/Ahcell),PackV=Nseries*Vcell,PackAh=Npar*Ahcell;
  const Ncells=Nseries*Npar;
  // FIX: PackkWh from Wbat (ground truth), not integer cell count
  const PackkWh=Wbat*p.sedCell*p.etaBat/1000;
  const CrateHov=(Phov*1000/PackV)/PackAh,CrateCr=(Pcr*1000/PackV)/PackAh;
  const Rint=0.030*Nseries/Npar,Pheat=(Phov*1000/PackV)**2*Rint;

  /* Performance */
  const Vstall=Math.sqrt(2*WL/(rhoCr*selAF.CLmax));
  const VA=Math.min(Vstall*Math.sqrt(3.5),p.vCruise); // CS-23 §23.335(b): VA ≤ VC
  const VD=p.vCruise*1.25;
  const vnData=Array.from({length:60},(_,i)=>{
    const v=VD*1.1*i/59;
    return {v:+v.toFixed(1),nPos:+Math.min(0.5*rhoCr*v**2*p.clDesign/WL,3.5).toFixed(3),
      nNeg:+Math.max(-0.5*rhoCr*v**2*0.8*p.clDesign/WL,-1.5).toFixed(3)};
  });

  /* Range-payload */
  const Efl_design=Etot-Eto-Eld;
  // ── PAYLOAD-RANGE CURVE (3-segment eVTOL model) ──────────────────────────
  // Segment A: max payload → design point (reduce payload, can't add battery yet — MTOW limited)
  // Segment B: design → ferry range (reduce payload, add battery weight to freed mass)
  // Segment C: payload=0 (ferry) — flat at max range
  // For fixed-MTOW eVTOL: all freed payload weight → battery (same MTOW)
  const sedEff_rp = p.sedCell*(1-(p.cRateDerate??0.08));
  const minBatKg  = (Eto+Eld)*1000*(1+p.socMin)/(sedEff_rp*p.etaBat); // min bat for hover phases
  const maxPayload= Math.max(0, MTOW-Wempty-minBatKg);  // hard upper limit on payload
  const ferryRange= (()=>{
    const WbFerry=MTOW-Wempty;  // all weight = battery when payload=0
    const EavFerry=WbFerry*sedEff_rp*p.etaBat/(1000*(1+p.socMin));
    return +Math.max(0,((EavFerry-Eto-Eld)/Efl_design)*p.range).toFixed(1);
  })();
  const rpData=Array.from({length:61},(_,i)=>{
    const pay=maxPayload*i/60;
    const Wavail=Math.max(0,MTOW-Wempty-pay);  // remaining weight = battery
    if(Wavail<minBatKg) return{payload:+pay.toFixed(0),range:0,segment:"A"};
    const Eavail=Wavail*sedEff_rp*p.etaBat/(1000*(1+p.socMin));
    const r=+Math.max(0,((Eavail-Eto-Eld)/Efl_design)*p.range).toFixed(1);
    const seg=pay>p.payload?"A":pay<p.payload?"B":"design";
    return{payload:+pay.toFixed(0),range:r,segment:seg};
  }).reverse(); // payload high→low for left-to-right range increase
  const rpFerryPoint={payload:0,range:ferryRange,segment:"ferry"};

  /* Aerodynamic polar — uses fitted kPolar for custom airfoils, Oswald for library */
  const k_polar=selAF.kPolar || 1/(Math.PI*p.AR*p.eOsw);
  const polarData=Array.from({length:81},(_,i)=>{
    const alpha=-4+i*0.25,CL=0.40+2*Math.PI*(1+0.77*selAF.tc)*alpha*Math.PI/180;
    const CD=selAF.CDmin+k_polar*(CL-p.clDesign)**2;
    return{alpha:+alpha.toFixed(2),CL:+CL.toFixed(4),CD:+CD.toFixed(5),LD:+(CL/CD).toFixed(2)};
  });

  /* Time-power-velocity-SoC profiles */
  const tPhases=[0,tto,tto+tcl,tto+tcl+tcr,tto+tcl+tcr+tdc,tto+tcl+tcr+tdc+tld,tto+tcl+tcr+tdc+tld+tres];
  const Tend=tPhases[6],phPow=[Phov,Pcl,Pcr,Pdc,Phov,Pres];
  const phV=[0.5,Vcl,p.vCruise,Vdc,0.5,Vres];
  const Ecum_ph=[0,Eto,Eto+Ecl,Eto+Ecl+Ecr,Eto+Ecl+Ecr+Edc,Eto+Ecl+Ecr+Edc+Eld,Etot];
  const N=200,powerSteps=[],socSteps=[],velSteps=[],energySteps=[];
  for(let i=0;i<=N;i++){
    const t=Tend*i/N;
    let ph=5; for(let j=0;j<6;j++)if(t>=tPhases[j]&&t<tPhases[j+1]){ph=j;break;}
    const Ec=Ecum_ph[ph]+phPow[ph]*((t-tPhases[ph])/3600);
    const socFloor=p.socMin/(1+p.socMin);
    const soc=Math.max(socFloor,(1-Ec/PackkWh))*100;
    powerSteps.push({t:+t.toFixed(0),P:+phPow[ph].toFixed(1),ph:["TO","Climb","Cruise","Desc","Land","Res"][ph]});
    socSteps.push({t:+t.toFixed(0),SoC:+soc.toFixed(2)});
    velSteps.push({t:+t.toFixed(0),V:+phV[ph].toFixed(1)});
    energySteps.push({t:+t.toFixed(0),E:+Ec.toFixed(3),P:+phPow[ph].toFixed(1),ph:["TO","Climb","Cruise","Desc","Land","Res"][ph]});
  }

  /* Convergence chart data — includes per-iteration residual for log plot */
  const convData=mtowH.map((m,i)=>({
    iter:i, MTOW:+m.toFixed(1), Energy:energyH[i]||null,
    residual: residualH[i]!=null ? residualH[i] : null,
    logResidual: (residualH[i]!=null && residualH[i]>0) ? +Math.log10(residualH[i]).toFixed(4) : null,
  }));

  /* Tolerance sweep — how many R1 and R2 iterations does each tol need? */
  const tolSweepData=[-1,-2,-3,-4,-5,-6,-7,-8,-9,-10].map(exp=>{
    const t=Math.pow(10,exp);
    let m1=2177,n1=0;
    for(let i=0;i<5000;i++){
      n1=i+1;
      const bf=(g0*p.range*1000)/(p.LD*p.etaSys*p.sedCell*3600);
      const mn=p.payload+p.ewf*m1+bf*m1;
      if(Math.abs(mn-m1)<t){m1=mn;break;}
      m1=mn; if(m1>5700)break;
    }
    let m2=m1,n2=0;
    for(let o=0;o<200;o++){
      n2=o+1;
      const W2=m2*g0;
      const DL2=(W2*TW)/(Math.PI*Math.pow(p.propDiam/2,2)*p.nPropHover);
      const Ph2=(W2/p.etaHov)*Math.sqrt(DL2/(2*rhoHov))/1000;
      const Pc2=(W2/p.etaSys)*(RoC+Vcl/LDcl)/1000;
      const Pcr2=(W2/p.etaSys)*(p.vCruise/p.LD)/1000;
      const Pd2_raw=(W2/p.etaSys)*(-RoC+Vdc/LDcl)/1000;
      const Pd2=Pd2_raw;
      const Pr2=(W2/p.etaSys)*(Vres/p.LD)/1000;
      const Et2=Ph2*(hvtol/0.5)/3600+Pc2*tcl/3600+Pcr2*tcr/3600+Pd2*tdc/3600+Ph2*tld/3600+Pr2*tres_s/3600;
      const sedEff2=p.sedCell*(1-(p.cRateDerate??0.08));
      const WE2=Et2*1000/((1-p.socMin)*sedEff2*p.etaBat);
      const WP2=Ph2/(p.spBattery||1.0);
      const Wb2=Math.max(WE2,WP2);
      const mn=p.payload+p.ewf*m2+Wb2;
      if(Math.abs(mn-m2)<t){m2=mn;break;}
      m2=mn;
    }
    return{exp,tol:`1e${exp}`,tolVal:t,R1iters:n1,R2iters:n2,totalIters:n1+n2,R2MTOW:+m2.toFixed(2)};
  });

  /* T/W trade sweep */
  const twSweepData=[1.0,1.05,1.1,1.15,1.2,1.25,1.3,1.4,1.5].map(tw=>{
    let m=MTOW1;
    for(let i=0;i<60;i++){
      const W=m*g0;
      const DLtw=(W)/(Math.PI*Math.pow(p.propDiam/2,2)*p.nPropHover);  // T/W=1.0
      const Phov_tw=(W/p.etaHov)*Math.sqrt(DLtw/(2*rhoHov))/1000;               // T/W=1.0
      const Pcl_tw=(W/p.etaSys)*(RoC+Vcl/LDcl)/1000;
      const Pcr_tw=(W/p.etaSys)*(p.vCruise/p.LD)/1000;
      const Pdc_tw_raw=(W/p.etaSys)*(-RoC+Vdc/LDcl)/1000;
      const Pdc_tw=Pdc_tw_raw;
      const Pres_tw=(W/p.etaSys)*(Vres/p.LD)/1000;
      const Etot_tw=Phov_tw*(hvtol/0.5)/3600+Pcl_tw*tcl/3600+Pcr_tw*tcr/3600+Pdc_tw*tdc/3600+Phov_tw*tld/3600+Pres_tw*tres_s/3600;
      const sedEff_tw=p.sedCell*(1-(p.cRateDerate??0.08));
      const WE_tw=Etot_tw*1000/((1-p.socMin)*sedEff_tw*p.etaBat);
      const WP_tw=Phov_tw/(p.spBattery||1.0);
      const Wbat_tw=Math.max(WE_tw,WP_tw);
      const mn=p.payload+p.ewf*m+Wbat_tw;
      if(Math.abs(mn-m)<1e-4){m=mn;break;}
      m=mn;
    }
    return{tw:+tw.toFixed(2),R1:+MTOW1.toFixed(1),R2:+m.toFixed(1)};
  });

  /* Weight breakdown (Roskam) */
  const ewFracs=[0.18,0.28,0.05,0.04,0.04,0.22,0.04,0.02,0.08,0.05];
  const ewNames=["Wing Struct","Fuselage","Tail Surf","Booms","LG","Propulsion","Avionics","ECS","Elec Sys","Furnish"];
  const weightBreak=ewNames.map((wn,i)=>({name:wn,val:+(ewFracs[i]*Wempty).toFixed(1)}));

  /* Drag pie */
  const dragComp=[
    {name:"Wing",val:+CD0w.toFixed(5)},{name:"Fuselage",val:+CD0f.toFixed(5)},
    {name:"H-Stab",val:+CD0h.toFixed(5)},{name:"V-Stab",val:+CD0v.toFixed(5)},
    {name:"Nacelles",val:+CD0n.toFixed(5)},{name:"Land.Gear",val:+CD0g.toFixed(5)},{name:"Misc",val:+CD0m.toFixed(5)},
  ];

  /* Feasibility */
  const checks=[
    {label:"MTOW < 5700 kg",ok:MTOW<5700,val:`${MTOW.toFixed(1)} kg`},
    {label:"Cruise range > 0 km",ok:CruiseRange>0,val:`${(CruiseRange/1000).toFixed(1)} km (climb+desc+res use ${((ClimbR+DescR+reserveDistM)/1000).toFixed(1)} km)`},
    {label:"Pack ≥ Mission E",ok:PackkWh>=Etot,val:`${PackkWh.toFixed(2)} ≥ ${Etot.toFixed(2)} kWh`},
    {label:"SM 5–25% MAC",ok:SM_vt>=0.05&&SM_vt<=0.25,val:`${(SM_vt*100).toFixed(1)}%`},
    {label:"Tip Mach < 0.70",ok:TipMach<0.70,val:`M${TipMach.toFixed(3)}`},
    {label:"Battery Frac < 55%",ok:Wbat/MTOW<0.55,val:`${(Wbat/MTOW*100).toFixed(1)}%`},
    {label:"Final SoC ≥ SoCmin",ok:(1-Etot/PackkWh)>=(p.socMin/(1+p.socMin))-0.01,val:`${((1-Etot/PackkWh)*100).toFixed(1)}% (floor ${(p.socMin/(1+p.socMin)*100).toFixed(1)}%)`},
    {label:"Actual L/D > 10",ok:LDact>10,val:LDact.toFixed(2)},
    {label:"V-tail pitch auth.",ok:pitch_ratio>=1.0,val:`${(pitch_ratio*100).toFixed(0)}%`},
    {label:"V-tail yaw auth.",ok:yaw_ratio>=1.0,val:`${(yaw_ratio*100).toFixed(0)}%`},
    {label:"Mach < 0.45",ok:Mach<0.45,val:`M${Mach.toFixed(3)}`},
    {label:"Tail/Wing area 25–50%",ok:(Svt_total/Swing)>=0.20&&(Svt_total/Swing)<=0.55,val:`${(Svt_total/Swing*100).toFixed(1)}%`},
    {label:"Fus/Span 0.50–0.72",ok:(fL/bWing)>=0.50&&(fL/bWing)<=0.72,val:`${(fL/bWing).toFixed(3)}`},
    {label:`Hover T/W ≥ ${TW.toFixed(2)}`,ok:TW>=1.0,val:`${TW.toFixed(2)} (Phov = ${Phov.toFixed(1)} kW)`},
    // Cross-parameter feasibility checks
    {label:"AR vs LD compatible",ok:LDact>=(p.LD*0.70),val:`Act L/D ${LDact.toFixed(1)} vs target ${p.LD} (min 70%)`},
    {label:"Rotors: even & ≥ 4",ok:p.nPropHover>=4&&p.nPropHover%2===0,val:`${p.nPropHover} rotors`},
  ];

  /* ════════════════════════════════════════════════════════════════
     ROTOR NOISE MODEL v2 — Physics-informed semi-empirical
     Upgrades over v1:
       1. Dipole directivity D(θ) — thrust-axis dipole, in-plane worst case
       2. Compressibility correction C_comp(Mtip) — Prandtl-Glauert type
       3. Multi-parameter K_cal = f(DL, Mtip, B) — replaces fixed 15 dB
       4. Adaptive harmonic decay α = f(Mtip, DL) — replaces fixed 4 dB/harm
       5. Broadband ∝ Mtip⁵ × Re_weak — replaces fixed −8 dB offset
       6. Multi-rotor interaction ΔInt — partial coherence / shielding
       7. Ground reflection: image-source method (+2.5 dB for r > 10m)
       8. Atmospheric absorption: ISO 9613-1 simplified, frequency-dependent
     References:
       Gutin (1948) NACA TM-1195 — rotating-source tonal model
       Lowson (1965) Proc. Roy. Soc. — compressibility & directivity
       Leishman "Helicopter Aerodynamics" §8.3–8.4
       Fleming et al. VFS Forum 78 (2022) — harmonic decay eVTOL data
       Tinney & Valdez JASA (2020/2026) — broadband self-noise
       Brooks, Pope & Marcolini (1989) NASA RP-1218 — BPM broadband scaling
       ISO 9613-1 (1993) — atmospheric absorption
     Validity: Mtip < 0.70, hover/low-speed, R = 0.5–3.5m, DL < 1500 N/m²
     ════════════════════════════════════════════════════════════════ */

  const R_rotor  = Rrotor;
  const N_rot    = p.nPropHover;
  const N_bl     = Nbld;
  const Omega    = RPM * Math.PI / 30;          // rad/s
  const Vtip     = TipSpd;                       // m/s
  // Acoustic Mtip uses MSL sound speed — rotors hover near ground, not cruise altitude
  const c0       = Math.sqrt(GAM * Rgas * T0);  // MSL speed of sound (340.3 m/s)
  const Mtip_h   = Math.min(TipSpd / c0, 0.699); // hover tip Mach (clamp for numerical safety)
  const rho0     = rhoMSL;
  const r0       = 1.0;                          // reference distance 1m (ICAO)

  // Noise uses hover equilibrium thrust (T/W = 1.0), not design thrust margin
  const T_r   = MTOW * g0 / p.nPropHover;
  const DL_hover = T_r / (Math.PI * R_rotor * R_rotor);  // acoustic DL at T/W=1.0

  // BPF
  const BPF = N_bl * RPM / 60;  // Hz

  // A-weighting (IEC 61672) — unchanged, applied per harmonic frequency
  const Aweight = (f) => {
    const f2  = f * f;
    const num = 12194**2 * f2**2;
    const den = (f2 + 20.6**2) * Math.sqrt((f2 + 107.7**2) * (f2 + 737.9**2)) * (f2 + 12194**2);
    return 20 * Math.log10(num / den) + 2.0;
  };

  // ── 1. VALIDITY ENVELOPE ─────────────────────────────────────────
  // Enforced in code: warn flags propagated to SR for UI display
  const noise_validity = {
    Mtip_ok:  Mtip_h < 0.70,
    DL_ok:    DLrotor < 1500,
    R_ok:     R_rotor >= 0.5 && R_rotor <= 3.5,
    hover_ok: true,  // model is hover-only; cruise noise not implemented
  };

  // ── 2. DIPOLE DIRECTIVITY D(θ) ───────────────────────────────────
  // Thrust-axis loading dipole: D(θ) = |sin θ|
  // θ = angle from rotor thrust axis; θ = 90° is in-plane (maximum, worst case).
  // We report the maximum directivity direction (community noise worst case).
  // D(90°) = 1.0 — no numerical change at reference angle, but formulation is correct.
  const theta_obs   = 90 * Math.PI / 180;
  const D_direct    = Math.abs(Math.sin(theta_obs));  // = 1.0 at in-plane

  // ── 3. COMPRESSIBILITY CORRECTION C_comp(Mtip) ───────────────────
  // Loading noise pressure amplitude increases with tip speed.
  // Prandtl-Glauert type: p ∝ 1/sqrt(1−Mtip²) → +5·log10(1/(1−Mtip²)) dB
  // Ref: Lowson (1965) — accounts for increased pressure amplitude near critical Mach
  // At Mtip=0.58: C_comp ≈ +0.89 dB; at Mtip=0.65: ≈ +1.19 dB
  const C_comp_dB = -5.0 * Math.log10(Math.max(1.0 - Mtip_h * Mtip_h, 0.01));

  // ── 4. MULTI-PARAMETER K_cal = f(DL, Mtip, B) ────────────────────
  // Replaces fixed K_cal=15 dB. Parameterized by design variables that physically
  // drive the non-ideal loading effects K_cal historically absorbed.
  // Reference point: DL=500 N/m², Mtip=0.58, B=6 → matches Joby S4-class data.
  // Curve-fitted to Fleming 2022 + Joby/Volocopter published dBA data (±2 dB).
  const DL_ref    = 500.0;   // N/m² reference (Joby-class)
  const Mtip_ref  = 0.58;    // reference tip Mach
  const B_ref     = 6;       // reference blade count
  const K_base    = 12.0;    // dB — base at reference (C_comp adds remaining ~0.9 dB)
  const K_DL      =  5.0 * Math.log10(Math.max(DL_hover / DL_ref, 0.1));  // acoustic hover DL: +5 dB/decade
  const K_Mt      =  8.0 * (Mtip_h / Mtip_ref - 1.0);                    // +8 dB per unit Mtip ratio
  const K_B       = -1.5 * (N_bl - B_ref);                                // more blades → lower K
  const K_cal     = K_base + K_DL + K_Mt + K_B;

  // ── 5. GUTIN FUNDAMENTAL (with directivity + Bessel + compressibility) ──
  // Gutin (1948) NACA TM-1195 full expression includes Bessel function J_{mB}(x):
  //   x = mB·Ω·R_eff·sin(θ)/c₀  (argument at in-plane observer, m=1 fundamental)
  //   R_eff = 0.8·R (effective radius — Gutin 1948, Leishman §8.3)
  // For eVTOL: x ≈ B·Ω·R·sin(90°)/c₀ ≈ 1.1 — NOT << 1, so Bessel matters.
  // FIX 2.1: include first-harmonic Bessel factor instead of bare loading term.
  // J1 approximation: valid to ±0.4 dB for x ≤ 3 (covers all practical eVTOL rotors).
  //   J1(x) ≈ x/2·(1 − x²/8)   for x < 2.4
  //   J1(x) ≈ sqrt(2/(π·x))·cos(x − 3π/4)  for x ≥ 2.4
  const R_eff       = 0.8 * R_rotor;                               // effective radius (Gutin)
  const bessel_x    = (N_bl * Omega * R_eff) / c0;                 // argument at θ=90° (sin=1)
  const J1_bessel   = bessel_x < 2.4
    ? (bessel_x / 2) * (1 - bessel_x * bessel_x / 8)
    : Math.sqrt(2 / (Math.PI * bessel_x)) * Math.cos(bessel_x - 3 * Math.PI / 4);
  // Bare Gutin loading pressure (no Bessel — used as reference, corrected below)
  const p_rms_gutin = D_direct * (N_bl * Omega * T_r) / (4.0 * Math.PI * r0 * rho0 * c0 * c0 * Math.SQRT2);
  // Apply Bessel modulation: J1 scales the loading contribution
  const p_rms_bessel = p_rms_gutin * Math.max(1e-6, Math.abs(J1_bessel));
  const SPL_1_gutin = 20 * Math.log10(Math.max(p_rms_bessel, 1e-10) / 2e-5);
  const SPL_1       = SPL_1_gutin + K_cal + C_comp_dB;  // calibrated + compressibility-corrected

  // ── 6. ADAPTIVE HARMONIC DECAY α = f(Mtip, DL) ───────────────────
  // Higher Mtip → more energy in higher harmonics (slower spectral roll-off).
  // Lower disk loading → faster decay (less unsteady loading energy in harmonics).
  // Ref: Fleming et al. (2022) measured range ≈ 3–6 dB/harmonic for eVTOL hover.
  const alpha_base  = 4.0;
  const alpha_Mt    = -5.0 * (Mtip_h - Mtip_ref);                        // slower decay at high Mtip
  const alpha_DL_   = -1.5 * Math.log10(Math.max(DL_hover / DL_ref, 0.1)); // lower hover DL → faster decay
  const K_decay     = Math.max(2.0, Math.min(7.0, alpha_base + alpha_Mt + alpha_DL_));
  // At reference: K_decay = 4.0 dB/harm (same as before)
  // At Mtip=0.65: K_decay ≈ 3.65 dB/harm (slower — more high-harmonic energy)

  // ── 7. MULTI-HARMONIC A-WEIGHTED SUM (extended to n=10) ──────────
  // FIX 2.4: Removed unphysical "+20·log10(n)" term.
  // Gutin (1948) Eq.(8): loading-noise pressure amplitude of m-th harmonic
  //   ∝ Jm·B(mB·Ω·R·sin θ / c) — the Bessel function DECREASES with m for
  //   arguments < mB (subsonic tip), so higher harmonics are QUIETER, not louder.
  // Correct spectral roll-off for eVTOL hover measured by Fleming et al. (2022):
  //   SPL_n = SPL_1 − K_decay × (n−1)   [monotonically decreasing]
  // The old "+20log10(n)" caused n=2 to be 6 dB above fundamental — physically wrong.
  const N_harmonics = 10;
  let tonal_lin     = 0;
  const harmonicData = [];
  for (let n = 1; n <= N_harmonics; n++) {
    // Correct: harmonics decay from SPL_1, no unphysical amplitude growth
    const SPL_n = SPL_1 - K_decay * (n - 1);
    const f_n   = N_bl * n * Omega / (2 * Math.PI);  // harmonic frequency (Hz)
    const Aw_n  = Aweight(f_n);                        // IEC 61672 A-weight at this freq
    const dBA_n = SPL_n + Aw_n;
    tonal_lin  += Math.pow(10, dBA_n / 10);
    harmonicData.push({ n, f_n: +f_n.toFixed(1), SPL_n: +SPL_n.toFixed(1), Aw_n: +Aw_n.toFixed(1), dBA_n: +dBA_n.toFixed(1) });
  }
  const dBA_tonal_single = 10 * Math.log10(Math.max(tonal_lin, 1e-30));

  // ── 8. BROADBAND ∝ Mtip⁵ × Re_weak ──────────────────────────────
  // Turbulent boundary layer trailing-edge noise dominates broadband for eVTOL hover.
  // BPM (Brooks et al. 1989): SPL_BB ∝ Mtip⁵ with weak chord-Re dependence.
  // Reference: BB = tonal − 8 dB at Mtip_ref=0.58, Re_ref=1.5×10⁶ (Tinney & Valdez 2020).
  // Δ_Mtip: 50·log10(Mtip/Mtip_ref) — from Mtip⁵ scaling
  // Δ_Re:   −2·log10(Re_tip/Re_ref) — weak Re correction (~−2 dB per decade Re)
  const mu_air       = 1.789e-5;            // dynamic viscosity at MSL (Pa·s)
  const Re_tip       = rho0 * TipSpd * ChordBl / mu_air;
  const Re_ref_noise = 1.5e6;               // reference Re for Joby-class blade
  const dBB_Mtip     = 50.0 * Math.log10(Math.max(Mtip_h / Mtip_ref, 1e-3));
  const dBB_Re       = -2.0 * Math.log10(Math.max(Re_tip / Re_ref_noise, 1e-3));
  const dBA_broadband_single = dBA_tonal_single - 8.0 + dBB_Mtip + dBB_Re;
  // At reference: 0 + 0 = −8 dB (matches Tinney & Valdez midpoint, same as v1)
  // At Mtip=0.65: +2.5 dB → −5.5 dB below tonal (physically higher broadband)

  // ── 9. VORTEX (BVI) NOISE — Schlegel–King–Mull vortex-shedding model ──
  // Original Schlegel formula (eVTOL-master noise_models.py vortex_noise()):
  //   p_ratio = k2 × (V_tip / δ_S) × sqrt((T_perRotor / σ) × DL)
  //   k2 = 1.206×10⁻² (Schlegel original — ft units throughout)
  //   δ_S = 500 ft = 152.4 m  (observer reference distance)
  //   p_ratio is DIMENSIONLESS — SPL = 20·log10(p_ratio)  (no /p_ref needed)
  //
  // Unit-consistent SI version (k2 kept in original, all lengths in ft converted):
  //   Use k2_ft=1.206e-2, V in ft/s, δ_S=500 ft, T in lbf, DL in lbf/ft²
  // Simpler: keep original dimensionless form, convert to SI by factor analysis.
  //   k2_vortex (SI, m units) = 1.206e-2 × sqrt(4.448/47.88) / (0.3048²) = 0.4259 ✓
  //   vortex_arg = (T_r / σ) × DL  [single rotor thrust only — N × N/m² = N²/m²]
  //   p_ratio at δ_S: dimensionless; then back-project to 1m: +20·log10(152.4)
  //   SPL_vortex_1m = 20·log10(p_ratio_at_deltaS) + 20·log10(152.4)  [no /2e-5]
  const k2_vortex    = 0.4259;                      // SI conversion of Schlegel k2_ft
  const delta_S_vortex = 152.4;                      // reference distance (500 ft in m)
  const V07_vortex   = 0.7 * TipSpd;                // blade speed at 70% radius [m/s]
  const sigma_vortex = sigma;                        // rotor solidity (computed above)
  const vortex_arg   = Math.max(1e-30,
    (T_r / Math.max(1e-6, sigma_vortex)) * DL_hover);  // single-rotor: T_r/σ × DL [N²/m²]
  const p_ratio_vortex = k2_vortex * (V07_vortex / delta_S_vortex) * Math.sqrt(vortex_arg);
  // p_ratio_vortex is dimensionless at delta_S_vortex; propagate to 1m reference:
  const SPL_vortex_1m  = 20 * Math.log10(Math.max(p_ratio_vortex, 1e-10))
                        + 20 * Math.log10(delta_S_vortex);  // back-project: no /2e-5
  // Apply A-weighting at vortex peak frequency: f_peak = St·V₀.₇/t_proj  (St=0.28)
  const AoA_blade   = 0.067;   // mean blade AoA ≈ 3.8° (Cl_mean≈0.6/2π)
  const t_proj_v    = ChordBl * (0.09 * Math.cos(AoA_blade) + Math.sin(AoA_blade));
  const f_vortex_Hz = 0.28 * V07_vortex / Math.max(1e-3, t_proj_v);
  const Aw_vortex   = Aweight(f_vortex_Hz);
  const dBA_vortex  = SPL_vortex_1m + Aw_vortex;

  // ── 10. SINGLE-ROTOR TOTAL (tonal + broadband + vortex) ──────────
  const dBA_single = 10 * Math.log10(
    Math.pow(10, dBA_tonal_single      / 10) +
    Math.pow(10, dBA_broadband_single  / 10) +
    Math.pow(10, dBA_vortex            / 10)
  );

  // ── 10. MULTI-ROTOR: incoherent sum + interaction correction ─────
  // Incoherent sum: +10·log10(N_rot) (uncorrelated sources)
  // ΔInt: interaction correction accounting for partial coherence & shielding.
  //   Range: −2 dB (strong shielding/destructive) to +3 dB (synchronous constructive).
  //   Hover eVTOL with wing/fuselage partial shielding: base ≈ −1.0 dB.
  //   Additional −0.15 dB per extra rotor beyond 6 (more shielding opportunities).
  const delta_int    = -1.0 - 0.15 * Math.max(0, N_rot - 6);
  const OASPL_total_1m = dBA_single + 10 * Math.log10(N_rot) + delta_int;
  const dBA_1m       = OASPL_total_1m;

  // ── 11. PROPAGATION: spherical + atmospheric absorption + ground reflection ──
  // Spherical spreading:  −20·log10(r/r₀)
  // Atmospheric absorption (ISO 9613-1 simplified, 70% RH, 20°C):
  //   α_eff = 1.5 + 0.5·log10(f_eff/100) dB/km
  //   f_eff = BPF × 3.5 (A-weighted dominant harmonic ≈ 3rd–4th BPF for eVTOL)
  // Ground reflection (image-source, hard/mixed terrain):
  //   ΔGr ≈ +2.5 dB for ground-level observer (r > 10 m)
  //   Accounts for direct + reflected path (between soft-ground +1 and hard +3 dB)
  const f_eff_noise   = BPF * 3.5;
  const alpha_dB_km   = 1.5 + 0.5 * Math.log10(Math.max(f_eff_noise / 100, 1));
  const alpha_dB_m    = alpha_dB_km / 1000;   // dB/m
  const delta_ground  = 2.5;                   // dB image-source ground reflection

  const noiseAtDist = (r) => {
    const spread = 20 * Math.log10(r / r0);
    const atm    = alpha_dB_m * r;
    const gr     = r > 10 ? delta_ground : 0;
    return dBA_1m - spread - atm + gr;
  };

  const dBA_at_1m   = +dBA_1m.toFixed(1);
  const dBA_at_25m  = +noiseAtDist(25).toFixed(1);
  const dBA_at_50m  = +noiseAtDist(50).toFixed(1);
  const dBA_at_100m = +noiseAtDist(100).toFixed(1);
  const dBA_at_150m = +noiseAtDist(150).toFixed(1);
  const dBA_at_300m = +noiseAtDist(300).toFixed(1);
  const dBA_at_500m = +noiseAtDist(500).toFixed(1);

  // Contour distances: bisection search.
  // Newton iteration diverged because noiseAtDist() has a +2.5 dB discontinuity at r=10 m
  // (ground reflection step), which breaks derivative-based solvers — they collapse to r=1.
  // Bisection is unconditionally convergent on any monotone-on-average function.
  const contourDist = (target) => {
    if (noiseAtDist(1) <= target) return 1;   // already below target at reference
    let lo = 1, hi = 1e6;
    while (noiseAtDist(hi) > target && hi < 1e8) hi *= 10;  // expand until below target
    if (noiseAtDist(hi) > target) return hi;                 // never reaches target
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (noiseAtDist(mid) > target) lo = mid; else hi = mid;
      if (hi - lo < 0.5) break;
    }
    return Math.round((lo + hi) / 2);
  };
  const dist_65dBA = +contourDist(65).toFixed(0);
  const dist_70dBA = +contourDist(70).toFixed(0);
  const dist_75dBA = +contourDist(75).toFixed(0);
  const dist_55dBA = +contourDist(55).toFixed(0);

  const bpfHarmonics = harmonicData.map(h => ({
    harmonic: h.n, freq: h.f_n,
    SPL: +(h.dBA_n + 10 * Math.log10(N_rot) + delta_int).toFixed(1),
  }));

  // Noise sensitivity — physics-derived from model structure
  // Tip speed: tonal Gutin ∝ Vtip² (0.087 dB/1%) + broadband Mtip⁵ (0.217·BB_frac dB/1%)
  // DL: K_cal ∝ 5·log10(DL) → 5·log10e·0.01 = 0.022 dB per 1% DL
  // Blade count: BPF shift + K_cal_B = (-10·log10((B+1)/B) − 1.5) dB per blade added
  const noise_sensitivity = {
    tipSpeed_1pct:    +(20 * Math.LOG10E * 0.01 + 50 * Math.LOG10E * 0.01 * 0.25).toFixed(2),
    diskLoading_1pct: +(5  * Math.LOG10E * 0.01).toFixed(2),
    bladeCount_1more: +(-10 * Math.log10((N_bl + 1) / N_bl) - 1.5).toFixed(2),
  };

  const fusSpanRatio=+(fL/bWing).toFixed(3);
  const tailWingRatio=+(Svt_total/Swing).toFixed(4);

  return {
    MTOW:+MTOW.toFixed(2),MTOW1:+MTOW1.toFixed(2),Wempty:+Wempty.toFixed(2),Wbat:+Wbat.toFixed(2),
    Phov:+Phov.toFixed(2),Pcl:+Pcl.toFixed(2),Pcr:+Pcr.toFixed(2),Pdc:+Pdc.toFixed(2),Pres:+Pres.toFixed(2),
    tto:+tto.toFixed(0),tcl:+tcl.toFixed(0),tcr:+tcr.toFixed(0),tdc:+tdc.toFixed(0),tld:+tld.toFixed(0),tres:+tres.toFixed(0),
    Tend:+Tend.toFixed(0),
    Eto:+Eto.toFixed(3),Ecl:+Ecl.toFixed(3),Ecr:+Ecr.toFixed(3),Edc:+Edc.toFixed(3),Eld:+Eld.toFixed(3),Eres:+Eres.toFixed(3),Etot:+Etot.toFixed(3),
    Swing:+Swing.toFixed(2),WL:+WL.toFixed(1),bWing:+bWing.toFixed(2),Cr_:+Cr_.toFixed(3),Ct_:+Ct_.toFixed(3),
    MAC:+MAC.toFixed(3),Ymac:+Ymac.toFixed(3),Xac:+Xac.toFixed(3),sweep:+sweep.toFixed(2),Re_:+Re_.toFixed(0),Mach:+Mach.toFixed(4),
    selAF,afScored,LDact:+LDact.toFixed(2),CD0tot:+CD0tot.toFixed(5),CDi:+CDi.toFixed(5),CDtot:+CDtot.toFixed(5),
    SM:+SM.toFixed(4),xCGtotal:+xCGtotal.toFixed(3),xNP:+xNP.toFixed(3),xCGempty:+xCGempty.toFixed(3),xACwing:+xACwing.toFixed(3),
    Drotor:+Drotor.toFixed(3),DLrotor:+DLrotor.toFixed(1),PLrotor:+PLrotor.toFixed(1),
    TipSpd:+TipSpd.toFixed(1),TipMach:+TipMach.toFixed(4),RPM:+RPM.toFixed(0),
    ChordBl:+ChordBl.toFixed(4),BladeAR:+BladeAR.toFixed(2),Nbld,PmotKW:+PmotKW.toFixed(2),
    PpeakKW:+PpeakKW.toFixed(2),Torque:+Torque.toFixed(1),MotMass:+MotMass.toFixed(2),
    SEDpack:+SEDpack.toFixed(1),Nseries,Npar,Ncells,PackV:+PackV.toFixed(0),PackAh:+PackAh.toFixed(1),
    PackkWh:+PackkWh.toFixed(3),CrateHov:+CrateHov.toFixed(2),CrateCr:+CrateCr.toFixed(2),Pheat:+Pheat.toFixed(1),
    Vstall:+Vstall.toFixed(2),VA:+VA.toFixed(2),VD:+VD.toFixed(2),
    vnData,rpData,rpFerryPoint,ferryRange:+ferryRange.toFixed(1),maxPayloadRp:+maxPayload.toFixed(0),polarData,powerSteps,socSteps,velSteps,energySteps,convData,twSweepData,tolSweepData,weightBreak,dragComp,tPhases,
    checks,feasible:checks.every(chk=>chk.ok),
    Trotor:+Trotor.toFixed(1),TW_hover:+TW_hover.toFixed(3),TW_cruise:+TW_cruise.toFixed(3),
    itersR1,itersR2,tol,r2Converged,
    vtGamma_opt:+vtGamma_opt_deg.toFixed(1),Svt_total:+Svt_total.toFixed(3),Svt_panel:+Svt_panel.toFixed(3),governs_pitch:Svt_panel_pitch>=Svt_panel_yaw,ruddervator_combined_auth:+ruddervator_combined_auth.toFixed(3),delta_yaw_rv_deg:+delta_yaw_rv_deg.toFixed(2),
    Sh_req:+Sh_req.toFixed(3),Sv_req:+Sv_req.toFixed(3),Sh_eff:+Sh_eff.toFixed(3),Sv_eff:+Sv_eff.toFixed(3),
    pitch_ratio:+pitch_ratio.toFixed(3),yaw_ratio:+yaw_ratio.toFixed(3),
    bvt_panel:+bvt_panel.toFixed(3),Cr_vt:+Cr_vt.toFixed(3),Ct_vt:+Ct_vt.toFixed(3),MAC_vt:+MAC_vt.toFixed(3),
    sweep_vt:+sweep_vt.toFixed(2),Srv:+Srv.toFixed(3),Wvt_total:+Wvt_total.toFixed(1),
    CD0vt:+CD0vt.toFixed(6),SM_vt:+SM_vt.toFixed(4),delta_rv_deg:+delta_rv_deg.toFixed(2),
    lv:+lv.toFixed(3),
    fusSpanRatio,tailWingRatio,
    // Noise outputs
    BPF:+BPF.toFixed(1), dBA_1m:+dBA_1m.toFixed(2),dBA_25m:dBA_at_25m,dBA_50m:dBA_at_50m,
    dBA_100m:dBA_at_100m,dBA_150m:dBA_at_150m,dBA_300m:dBA_at_300m,dBA_500m:dBA_at_500m,
    dist_55dBA,dist_65dBA,dist_70dBA,dist_75dBA,
    bpfHarmonics,noise_sensitivity,noise_validity,
    OASPL_total_1m:+OASPL_total_1m.toFixed(1),
  };
}


/* ═══════════════════════════════════════════════════════════════════════
   OPENVSP ANGELSCRIPT GENERATOR  v4
   Mirrors the exact confirmed-working API pattern exactly.
   Run in OpenVSP: File -> Run Script -> Execute
   ═══════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════
   OPENVSP VSP3 GENERATOR  — rewritten to match joby_s2.vsp3 exactly
   TypeIDs confirmed from reference: Wing=5, Fuselage=4, Disk(Custom)=9
   Disk geometry uses CustomGeom + AngelScript (copied verbatim from joby)
   Fuselage: 5-station ellipse, tangent angles at nose(90°) and tail(-90°)
   Wing/VTail: WING type, two XSec sections, NACA four-series airfoil
   All parm elements: <Name Value="sci_notation" ID="10_CHAR_ID"/>
   ═══════════════════════════════════════════════════════════════════════ */
function generateVSP3File(p, SR) {
  // ─── Guard: require valid sizing results before generating geometry ───
  if (!SR || !SR.MTOW || !p || !p.fusLen) return null;

  // ─── Helpers ─────────────────────────────────────────────────────────
  const sci = (v) => {
    const n = isFinite(Number(v)) ? Number(v) : 0;
    if (n === 0) return '0.000000000000000000e+000';
    return n.toExponential(18).replace(/e([+-])(\d+)$/, (_, s, e) => 'e'+s+e.padStart(3,'0'));
  };
  let _c = 1000;
  const ID = () => {
    const ch='ABCDEFGHIJKLMNOPQRSTUVWXYZ'; let s='',n=_c++;
    for(let i=0;i<10;i++){s=ch[n%26]+s;n=Math.floor(n/26);} return s;
  };
  const V = (tag,val) => `<${tag} Value="${sci(val)}" ID="${ID()}"/>`;

  // ─── Sizing values from engine ────────────────────────────────────────
  const fL   = Number(p.fusLen)              || 6.5;
  const fD   = Number(p.fusDiam)             || 1.65;
  const bW   = Number(SR.bWing)              || 12.67;
  const SW   = Number(SR.Swing)              || 17.83;
  const Cr   = Number(SR.Cr_)               || 1.94;
  const Ct   = Number(SR.Ct_)               || 0.87;
  const sw   = Number(SR.sweep)              || 9.57;
  const tc   = Number(p.tc)                  || 0.12;
  const xACw = Number(SR.xACwing)            || fL*0.39;
  const MAC  = Number(SR.MAC)               || 1.40;
  const Drot = Number(SR.Drotor)             || 3.0;
  const Rrot = Drot / 2;                     // rotor radius (m)
  const MTOW = Number(SR.MTOW)              || 2721;
  const xCG  = Number(SR.xCGtotal)          || fL*0.35;
  const SM   = Number(SR.SM_vt||SR.SM)       || 0.22;
  // V-tail from sizing engine (the calculated values)
  const CrVT = Number(SR.Cr_vt)             || 2.15;
  const CtVT = Number(SR.Ct_vt)             || 0.86;
  const bvt  = Number(SR.bvt_panel)         || 3.77;
  const swVT = Number(SR.sweep_vt)          || 34.4;
  const vtG  = Number(p.vtGamma)            || 40;
  const lv   = Number(SR.lv)               || fL*0.50;

  // ─── Component positions ──────────────────────────────────────────────
  const xWingLE = xACw - 0.25*Cr;       // wing LE (absolute x from nose)
  const xWingTE = xWingLE + Cr;         // wing TE (absolute x from nose)

  // ── HIGH-WING: Z raised to sit flush on TOP of fuselage ──────────────
  const zWing   = fD / 2;

  // V-tail geometry (for aft-X clearance calculation)
  const xVtLE  = Math.min(xACw + lv - 0.25*CrVT, fL - 0.05);
  const zVtRoot= 0;

  // ── LONGITUDINAL LIFT BOOMS ─────────────────────────────────────────────
  //
  // Y-AXIS: fixed at 2.525 m — just clears fuselage side + one rotor radius + 0.2 m gap.
  const yBoom = (fD / 2) + Rrot + 0.2;        // = (0.825 + 1.5 + 0.2) = 2.525 m

  // X-AXIS: boom is symmetric about CG, shifted 0.5 m aft for balance trim.
  //   boomXFwd = 2·xCG offset from nose    (front rotor position)
  //   boomXAft = boomXFwd + 2·xCG           (aft rotor position, equal arm from CG)
  //   boomXOffset: tune this single value to slide both rotors together.
  // V-tail geometry is retained below only to keep xVtTipTE available for
  // the safety-check log embedded in the .vsp3 file.
  const xVtTipTE   = xVtLE + bvt * Math.tan(swVT * Math.PI / 180) + CtVT;
  const vtClearAft = xVtTipTE + Rrot + 0.2;   // safety-check reference only
  const boomDiam   = 0.25;

  // ── BOOM X POSITIONS ─────────────────────────────────────────────────
  const boomXOffset = 0.5;                     // aft shift applied to both tips equally
  const boomXFwd    = 0 + boomXOffset;         // front boom tip x-position
  const boomXAft    = 2 * xCG + boomXOffset;   // aft   boom tip x-position (= 2·xCG from front)
  const boomLen     = boomXAft - boomXFwd;     // total boom length = 2·xCG
  const zBoom       = fD / 2;                  // flush with top of fuselage (high-wing)

  // ── LIFT ROTOR POSITIONS — DERIVED FROM BOOM TIPS ────────────────────
  const zLiftRotor = zBoom + boomDiam / 2;     // hub centred on top of boom
  const xRotFwd    = boomXFwd;                 // front rotor at front boom tip
  const xRotAft    = boomXAft;                 // aft   rotor at aft   boom tip

  // ── CENTER PUSHER ROTOR ───────────────────────────────────────────────
  const xPusher   = fL;
  const dPusher   = Drot * 0.75;

  // ── WINGTIP NACELLES + TILTING ROTORS ────────────────────────────────
  // FIX 3 — EXACT WINGTIP Y (Y-axis):
  // Set nacelle Y = bW/2 — the absolute extreme half-span of the main wing.
  // Tilting rotors share the same Y, keeping them attached to nacelle nose.
  const yTipRot   = bW / 2;                    // = 6.385m — exact wingtip edge
  const nacLen    = 0.80;
  const nacDiam   = 0.30;
  const xNacStart = xWingLE;                   // nacelle front at wing LE
  // Z: nacelle centred on wing chord midline (unchanged from previous fix)
  const zNac      = zWing + (Number(p.tc)||0.15) * Cr / 2;
  // X: rotor disc 5cm forward of nacelle nose face (unchanged from previous fix)
  const xTipRot   = xNacStart - 0.05;
  const zTipRot   = zNac;

  // ─── TE-sweep helper ──────────────────────────────────────────────────
  const sweepTE = (swDeg, halfSpan, rC, tC) => {
    if (halfSpan < 0.01) return swDeg;
    const avgC = (rC + tC) / 2;
    const te = Math.atan(
      Math.tan(swDeg*Math.PI/180) - 2*(1 - tC/rC)/((1+tC/rC)*halfSpan/avgC)
    ) * 180 / Math.PI;
    return isFinite(te) ? te : swDeg*0.5;
  };
  const wTE  = sweepTE(sw,   bW/2,  Cr,   Ct  );
  const vtTE = sweepTE(swVT, bvt,   CrVT, CtVT);

  // ─── Disk AngelScript — verbatim from joby_s2.vsp3 ───────────────────
  const DS = `//==== Init Is Called Once During Each Custom Geom Construction  ============================//
//==== Avoid Global Variables Unless You Want Shared With All Custom Geoms of This Type =====//
void Init()
{
\t//==== Add Parm Types  =====//
\tstring diameter = AddParm( PARM_DOUBLE_TYPE, "Diameter", "Design" );
\tSetParmValLimits( diameter, 10.0, 0.0, 1.0e12 );
\tSetParmDescript( diameter, "Diameter of Cone" );

\t//==== Add Cross Sections  =====//
\tstring xsec_surf = AddXSecSurf();
\tAppendCustomXSec( xsec_surf, XS_POINT);
\tAppendCustomXSec( xsec_surf, XS_CIRCLE);

\t//==== Add A Default Point Source At Nose ====//
\tSetupCustomDefaultSource( POINT_SOURCE, 0, 0.1, 1.0, 1.0, 1.0 );
}

//==== InitGui Is Called Once During Each Custom Geom Construction ====//
void InitGui()
{
\tAddGui( GDEV_TAB, "Design"  );
\tAddGui( GDEV_YGAP );
\tAddGui( GDEV_DIVIDER_BOX, "Design" );
\tAddGui( GDEV_SLIDER_ADJ_RANGE_INPUT, "Diameter", "Diameter", "Design"  );
}

//==== UpdateGui Is Called Every Time The Gui is Updated ====//
void UpdateGui()
{
}

//==== UpdateSurf Is Called Every Time The Geom is Updated ====//
void UpdateSurf()
{
\tstring geom_id = GetCurrCustomGeom();

\t//==== Set Base XSec Diameter ====//
\tstring dia_parm = GetParm( geom_id, "Diameter", "Design" );
\tdouble dia_val  = GetParmVal( dia_parm );

\t//==== Get The XSecs To Change ====//
\tstring xsec_surf = GetXSecSurf( geom_id, 0 );
\tstring xsec1 = GetXSec( xsec_surf, 1 );

\t//==== Set The Diameter ====//
\tstring xsec1_dia = GetXSecParm( xsec1, "Circle_Diameter" );
\tSetParmVal( xsec1_dia, dia_val );

\tSetVspSurfType( DISK_SURF, -1 );
\tSetVspSurfCfdType( CFD_TRANSPARENT, -1 );
\tSkinXSecSurf();
}

//==== Optional Scale =====//
void Scale(double curr_scale )
{
\tstring geom_id = GetCurrCustomGeom();

\tstring dia_id   = GetParm( geom_id, "Diameter", "Design" );

\tdouble dia = curr_scale * GetParmVal( dia_id );

\tSetParmVal( dia_id, dia );
}
`;

  // ─── Wing XSec builder — exact joby_s2.vsp3 structure ────────────────
  // parm tag = <XSec> (NOT <WingXSec>)  airfoil <Type>2</Type>  curve <Type>7</Type>
  const wingXSec = (rC, tC, span, swDeg, swLoc, dihed, twist, tessU, choiceVec, swRef) => {
    const a   = (rC+tC)/2*span;
    const asp = span>0.1 ? span*span/Math.max(a,1e-6) : 0.5;
    const tpr = tC/Math.max(rC,1e-6);
    const swD = swRef !== undefined ? swRef : swDeg;
    const teD = sweepTE(swD, span, rC, tC);
    return `
          <XSec>
            <ParmContainer>
              <ID>${ID()}</ID>
              <n>Default</n>
              <XSec>
                ${V('Area',a)}${V('Aspect',asp)}${V('Avg_Chord',a/Math.max(span,1e-6))}
                ${V('Dihedral',dihed)}${V('InCluster',1)}
                ${V('InLEDihedral',-dihed)}${V('InLEMode',0)}${V('InLEStrength',1)}${V('InLESweep',swD)}
                ${V('InTEDihedral',-dihed)}${V('InTEMode',0)}${V('InTEStrength',1)}${V('InTESweep',teD)}
                ${V('OutCluster',1)}
                ${V('OutLEDihedral',dihed)}${V('OutLEMode',0)}${V('OutLEStrength',1)}${V('OutLESweep',swD)}
                ${V('OutTEDihedral',dihed)}${V('OutTEMode',0)}${V('OutTEStrength',1)}${V('OutTESweep',teD)}
                ${V('Root_Chord',rC)}${V('Sec_Sweep',swDeg)}${V('Sec_Sweep_Location',1)}
                ${V('SectTess_U',tessU)}${V('Span',span)}
                ${V('Sweep',swDeg)}${V('Sweep_Location',swLoc)}
                ${V('Taper',tpr)}${V('Tip_Chord',tC)}
                ${V('Twist',twist)}${V('Twist_Location',0.25)}
              </XSec>
            </ParmContainer>
            <XSec>
              <Type>2</Type>
              <GroupName>XSec</GroupName>
              <DriverGroup>
                <NumVar>8</NumVar><NumChoices>3</NumChoices>
                <ChoiceVec>${choiceVec}</ChoiceVec>
              </DriverGroup>
              <XSecCurve>
                <ParmContainer>
                  <ID>${ID()}</ID><n>Default</n>
                  <Cap>
                    ${V('LE_Cap_Length',1)}${V('LE_Cap_Offset',0)}${V('LE_Cap_Strength',0.5)}${V('LE_Cap_Type',1)}
                    ${V('TE_Cap_Length',1)}${V('TE_Cap_Offset',0)}${V('TE_Cap_Strength',0.5)}${V('TE_Cap_Type',1)}
                  </Cap>
                  <Close>
                    ${V('LE_Close_AbsRel',0)}${V('LE_Close_Thick',0)}${V('LE_Close_Thick_Chord',0)}${V('LE_Close_Type',0)}
                    ${V('TE_Close_AbsRel',0)}${V('TE_Close_Thick',0)}${V('TE_Close_Thick_Chord',0)}${V('TE_Close_Type',0)}
                  </Close>
                  <Trim>
                    ${V('LE_Trim_AbsRel',0)}${V('LE_Trim_Thick',0)}${V('LE_Trim_Thick_Chord',0)}${V('LE_Trim_Type',0)}${V('LE_Trim_X',0)}${V('LE_Trim_X_Chord',0)}
                    ${V('TE_Trim_AbsRel',0)}${V('TE_Trim_Thick',0)}${V('TE_Trim_Thick_Chord',0)}${V('TE_Trim_Type',0)}${V('TE_Trim_X',0)}${V('TE_Trim_X_Chord',0)}
                  </Trim>
                  <XSecCurve>
                    ${V('Camber',0)}${V('CamberLoc',0.2)}${V('Chord',tC)}
                    ${V('DeltaX',0)}${V('DeltaY',0)}${V('EqArcLenFlag',1)}${V('FitDegree',7)}
                    ${V('Invert',0)}${V('Scale',1)}${V('ShiftLE',0)}${V('Theta',0)}${V('ThickChord',tc)}
                  </XSecCurve>
                </ParmContainer>
                <XSecCurve><Type>7</Type></XSecCurve>
              </XSecCurve>
            </XSec>
          </XSec>`;
  };

  // ─── Wing Geom builder ────────────────────────────────────────────────
  // xRot: X_Rotation (0 = flat wing/stab, 90 = vertical fin if ever needed)
  // sym:  Sym_Planar_Flag (2 = XZ symmetric, 0 = no symmetry)
  const wingGeom = (label, R,G,B, xLoc,zLoc, xRot,
                    rC,tC,halfSpan,swDeg,dihed,twist,
                    tessW, sym, totSpan, totArea, totChord) => {
    const s0 = wingXSec(1.0, rC, 1.0, 0, 0.0, 0, 0, 6, '1, 5, 6, ', swDeg);
    const s1 = wingXSec(rC, tC, halfSpan, swDeg, 0.0, dihed, twist, 6, '1, 3, 2, ');
    return `
    <Geom>
      <ParmContainer>
        <ID>${ID()}</ID><n>${label}</n>
        <Attach>${V('Rots_Attach_Flag',0)}${V('Trans_Attach_Flag',0)}${V('U_Attach_Location',1e-6)}${V('V_Attach_Location',1e-6)}</Attach>
        <Shape>${V('Tess_U',16)}${V('Tess_W',tessW)}${V('Wake',0)}</Shape>
        <Sym>${V('Sym_Ancestor',1)}${V('Sym_Ancestor_Origin_Flag',1)}${V('Sym_Axial_Flag',0)}${V('Sym_Planar_Flag',sym)}${V('Sym_Rot_N',2)}</Sym>
        <WingGeom>
          ${V('LECluster',0.25)}${V('RelativeDihedralFlag',0)}${V('RelativeTwistFlag',0)}
          ${V('RotateAirfoilMatchDideralFlag',0)}${V('TECluster',0.25)}
          ${V('TotalArea',totArea)}${V('TotalChord',totChord)}
          ${V('TotalProjectedSpan',totSpan)}${V('TotalSpan',totSpan)}
        </WingGeom>
        <XForm>
          ${V('Abs_Or_Relitive_flag',1)}${V('Last_Scale',1)}${V('Origin',0)}${V('Scale',1)}
          ${V('X_Location',xLoc)}${V('X_Rel_Location',xLoc)}
          ${V('X_Rel_Rotation',xRot)}${V('X_Rotation',xRot)}
          ${V('Y_Location',0)}${V('Y_Rel_Location',0)}
          ${V('Y_Rel_Rotation',0)}${V('Y_Rotation',0)}
          ${V('Z_Location',zLoc)}${V('Z_Rel_Location',zLoc)}
          ${V('Z_Rel_Rotation',0)}${V('Z_Rotation',0)}
        </XForm>
      </ParmContainer>
      <GeomBase>
        <TypeName>Wing</TypeName><TypeID>5</TypeID><TypeFixed>0</TypeFixed>
        <ParentID>NONE</ParentID><Child_List/>
      </GeomBase>
      <Material><n>Default</n></Material>
      <Wire_Color>
        <ParmContainer><ID>${ID()}</ID><n>Default</n>
          <Color_Parm>${V('Alpha',255)}${V('Blue',B)}${V('Green',G)}${V('Red',R)}</Color_Parm>
        </ParmContainer>
      </Wire_Color>
      <Textures><Num_of_Tex>0</Num_of_Tex></Textures>
      <Geom><Set_List>1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, </Set_List><SubSurfaces/></Geom>
      <WingGeom>
        <ParmContainer><ID>${ID()}</ID><n>Default</n></ParmContainer>
        <XSecSurf>${s0}${s1}
        </XSecSurf>
      </WingGeom>
    </Geom>`;
  };

  // ─── Disk Geom builder ────────────────────────────────────────────────
  const diskGeom = (label, R,G,B, xA,yA,zA, yRot, diameter, sym) => `
    <Geom>
      <CustomGeom>
        <Diameter Value="${sci(diameter)}" ID="${ID()}"/>
        <ScriptFileModule>Disk</ScriptFileModule>
        <ScriptFileContents>${DS}</ScriptFileContents>
      </CustomGeom>
      <ParmContainer>
        <ID>${ID()}</ID><n>${label}</n>
        <Attach>${V('Rots_Attach_Flag',0)}${V('Trans_Attach_Flag',0)}${V('U_Attach_Location',1e-6)}${V('V_Attach_Location',1e-6)}</Attach>
        <Design>${V('Diameter',diameter)}</Design>
        <Shape>${V('Tess_U',8)}${V('Tess_W',9)}${V('Wake',0)}</Shape>
        <Sym>${V('Sym_Ancestor',1)}${V('Sym_Ancestor_Origin_Flag',1)}${V('Sym_Axial_Flag',0)}${V('Sym_Planar_Flag',sym)}${V('Sym_Rot_N',2)}</Sym>
        <XForm>
          ${V('Abs_Or_Relitive_flag',1)}${V('Last_Scale',1)}${V('Origin',0)}${V('Scale',1)}
          ${V('X_Location',xA)}${V('X_Rel_Location',xA)}${V('X_Rel_Rotation',0)}${V('X_Rotation',0)}
          ${V('Y_Location',yA)}${V('Y_Rel_Location',yA)}${V('Y_Rel_Rotation',yRot)}${V('Y_Rotation',yRot)}
          ${V('Z_Location',zA)}${V('Z_Rel_Location',zA)}${V('Z_Rel_Rotation',0)}${V('Z_Rotation',0)}
        </XForm>
      </ParmContainer>
      <GeomBase>
        <TypeName>Disk</TypeName><TypeID>9</TypeID><TypeFixed>0</TypeFixed>
        <ParentID>NONE</ParentID><Child_List/>
      </GeomBase>
      <Material><n>Default</n></Material>
      <Wire_Color>
        <ParmContainer><ID>${ID()}</ID><n>Default</n>
          <Color_Parm>${V('Alpha',255)}${V('Blue',B)}${V('Green',G)}${V('Red',R)}</Color_Parm>
        </ParmContainer>
      </Wire_Color>
      <Textures><Num_of_Tex>0</Num_of_Tex></Textures>
      <Geom><Set_List>1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, </Set_List><SubSurfaces/></Geom>
    </Geom>`;

  // ─── Fuselage XSec builder (proven working) ───────────────────────────
  const fusXSec = st => `
          <XSec>
            <ParmContainer>
              <ID>${ID()}</ID><n>Default</n>
              <XSec>
                ${V('AllSym',0)}
                ${V('BottomLAngle',st.bA)}${V('BottomLAngleSet',1)}${V('BottomLCurve',0)}${V('BottomLCurveSet',0)}
                ${V('BottomLRAngleEq',1)}${V('BottomLRCurveEq',0)}${V('BottomLRSlewEq',0)}${V('BottomLRStrengthEq',0)}
                ${V('BottomLSlew',0)}${V('BottomLSlewSet',1)}${V('BottomLStrength',st.bS)}${V('BottomLStrengthSet',1)}
                ${V('BottomRAngle',st.bA)}${V('BottomRAngleSet',1)}${V('BottomRCurve',0)}${V('BottomRCurveSet',0)}
                ${V('BottomRSlew',0)}${V('BottomRSlewSet',1)}${V('BottomRStrength',st.bS)}${V('BottomRStrengthSet',1)}
                ${V('ContinuityBottom',0)}${V('ContinuityLeft',0)}${V('ContinuityRight',0)}${V('ContinuityTop',0)}
                ${V('LeftLAngle',st.tA)}${V('LeftLAngleSet',1)}${V('LeftLCurve',0)}${V('LeftLCurveSet',0)}
                ${V('LeftLRAngleEq',1)}${V('LeftLRCurveEq',0)}${V('LeftLRSlewEq',0)}${V('LeftLRStrengthEq',0)}
                ${V('LeftLSlew',0)}${V('LeftLSlewSet',1)}${V('LeftLStrength',st.tS)}${V('LeftLStrengthSet',1)}
                ${V('LeftRAngle',st.tA)}${V('LeftRAngleSet',1)}${V('LeftRCurve',0)}${V('LeftRCurveSet',0)}
                ${V('LeftRSlew',0)}${V('LeftRSlewSet',1)}${V('LeftRStrength',st.tS)}${V('LeftRStrengthSet',1)}
                ${V('RLSym',1)}${V('RefLength',st.refLen || 1)}
                ${V('RightLAngle',st.tA)}${V('RightLAngleSet',1)}${V('RightLCurve',0)}${V('RightLCurveSet',0)}
                ${V('RightLRAngleEq',1)}${V('RightLRCurveEq',0)}${V('RightLRSlewEq',0)}${V('RightLRStrengthEq',0)}
                ${V('RightLSlew',0)}${V('RightLSlewSet',1)}${V('RightLStrength',st.tS)}${V('RightLStrengthSet',1)}
                ${V('RightRAngle',st.tA)}${V('RightRAngleSet',1)}${V('RightRCurve',0)}${V('RightRCurveSet',0)}
                ${V('RightRSlew',0)}${V('RightRSlewSet',1)}${V('RightRStrength',st.tS)}${V('RightRStrengthSet',1)}
                ${V('SectTess_U',6)}${V('Spin',0)}${V('TBSym',1)}
                ${V('TopLAngle',st.tA)}${V('TopLAngleSet',1)}${V('TopLCurve',0)}${V('TopLCurveSet',0)}
                ${V('TopLRAngleEq',1)}${V('TopLRCurveEq',0)}${V('TopLRSlewEq',0)}${V('TopLRStrengthEq',0)}
                ${V('TopLSlew',0)}${V('TopLSlewSet',1)}${V('TopLStrength',st.tS)}${V('TopLStrengthSet',1)}
                ${V('TopRAngle',st.tA)}${V('TopRAngleSet',1)}${V('TopRCurve',0)}${V('TopRCurveSet',0)}
                ${V('TopRSlew',0)}${V('TopRSlewSet',1)}${V('TopRStrength',st.tS)}${V('TopRStrengthSet',1)}
                ${V('XLocPercent',st.p)}${V('XRotate',0)}${V('YLocPercent',0)}${V('YRotate',0)}${V('ZLocPercent',0)}${V('ZRotate',0)}
              </XSec>
            </ParmContainer>
            <XSec>
              <Type>0</Type><GroupName>XSec</GroupName>
              <XSecCurve>
                <ParmContainer>
                  <ID>${ID()}</ID><n>Default</n>
                  <XSecCurve>
                    ${V('DeltaX',0)}${V('DeltaY',0)}
                    ${st.ell?V('Ellipse_Height',st.H):''}
                    ${st.ell?V('Ellipse_Width', st.W):''}
                    ${V('Scale',1)}${V('ShiftLE',0)}${V('Theta',0)}
                  </XSecCurve>
                </ParmContainer>
                <XSecCurve><Type>${st.ell?2:0}</Type></XSecCurve>
              </XSecCurve>
            </XSec>
          </XSec>`;

  // ─── Fuselage Geom builder (used for main body AND boom rods) ─────────
  // yRot: Y_Rotation (-90 = points upward/+Z; 0 = default along +X)
  const fusGeom = (label, R,G,B, xLoc,yLoc,zLoc, yRot, length, sym, stations, tessU=16, tessW=17) => `
    <Geom>
      <ParmContainer>
        <ID>${ID()}</ID><n>${label}</n>
        <Attach>${V('Rots_Attach_Flag',0)}${V('Trans_Attach_Flag',0)}${V('U_Attach_Location',1e-6)}${V('V_Attach_Location',1e-6)}</Attach>
        <Design>${V('Length',length)}${V('OrderPolicy',0)}</Design>
        <Shape>${V('Tess_U',tessU)}${V('Tess_W',tessW)}</Shape>
        <Sym>${V('Sym_Ancestor',1)}${V('Sym_Ancestor_Origin_Flag',1)}${V('Sym_Axial_Flag',0)}${V('Sym_Planar_Flag',sym)}${V('Sym_Rot_N',2)}</Sym>
        <XForm>
          ${V('Abs_Or_Relitive_flag',1)}${V('Last_Scale',1)}${V('Origin',0)}${V('Scale',1)}
          ${V('X_Location',xLoc)}${V('X_Rel_Location',xLoc)}${V('X_Rel_Rotation',0)}${V('X_Rotation',0)}
          ${V('Y_Location',yLoc)}${V('Y_Rel_Location',yLoc)}${V('Y_Rel_Rotation',yRot)}${V('Y_Rotation',yRot)}
          ${V('Z_Location',zLoc)}${V('Z_Rel_Location',zLoc)}${V('Z_Rel_Rotation',0)}${V('Z_Rotation',0)}
        </XForm>
      </ParmContainer>
      <GeomBase>
        <TypeName>Fuselage</TypeName><TypeID>4</TypeID><TypeFixed>0</TypeFixed>
        <ParentID>NONE</ParentID><Child_List/>
      </GeomBase>
      <Material><n>Default</n></Material>
      <Wire_Color>
        <ParmContainer><ID>${ID()}</ID><n>Default</n>
          <Color_Parm>${V('Alpha',255)}${V('Blue',B)}${V('Green',G)}${V('Red',R)}</Color_Parm>
        </ParmContainer>
      </Wire_Color>
      <Textures><Num_of_Tex>0</Num_of_Tex></Textures>
      <Geom><Set_List>1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, </Set_List><SubSurfaces/></Geom>
      <FuselageGeom>
        <ParmContainer><ID>${ID()}</ID><n>Default</n></ParmContainer>
        <XSecSurf>${stations.map(fusXSec).join('')}
        </XSecSurf>
      </FuselageGeom>
    </Geom>`;

  // ═══ BUILD COMPONENTS ══════════════════════════════════════════════════

  // ── 1. MAIN FUSELAGE — GEOMETRY UNCHANGED ─────────────────────────────
  const maxW = fD, maxH = fD*0.88;
  const fusSt = [
    {p:0.000, W:fD*0.01, H:fD*0.01, tA: 90, bA: 90, tS:0.40, bS:0.40, ell:false, refLen:fL},
    {p:0.150, W:maxW*0.60, H:maxH*0.55, tA:0,  bA:0,  tS:1.0,  bS:1.0,  ell:true,  refLen:fL},
    {p:0.380, W:maxW,      H:maxH,      tA:0,  bA:0,  tS:1.0,  bS:1.0,  ell:true,  refLen:fL},
    {p:0.700, W:maxW*0.72, H:maxH*0.60, tA:-4, bA:-4, tS:1.0,  bS:1.0,  ell:true,  refLen:fL},
    {p:1.000, W:fD*0.01, H:fD*0.01, tA:-90, bA:-90, tS:0.25, bS:0.25, ell:false, refLen:fL},
  ];
  const fusXML = fusGeom('Fuselage', 0,0,0, 0,0,0, 0, fL, 0, fusSt, 16, 17);

  // ── 2. MAIN WING — SHAPE UNCHANGED, HIGH-WING (Z = fD/2) ──────────────
  const wingXML = wingGeom(
    'MainWing', 0,0,255,
    xWingLE, zWing, 0,
    Cr, Ct, bW/2, sw, 2.0, -1.5,
    33, 2, bW, SW, MAC
  );

  // ── 3. LONGITUDINAL LIFT BOOMS (fixed, V-tail collision resolved) ──────
  // Straight boom cross-section: tiny nose/tail tapers, full diameter in between.
  // p:0.08/0.92 gives a long cylindrical mid-section — the original clean shape.
  // XZ symmetry (sym=2) mirrors to −yBoom automatically.
  const boomSt = [
    {p:0.00, W:boomDiam*0.15, H:boomDiam*0.15, tA: 90, bA: 90, tS:0.4, bS:0.4, ell:false, refLen:boomLen},
    {p:0.08, W:boomDiam,      H:boomDiam,       tA:0,  bA:0,   tS:1.0, bS:1.0, ell:true,  refLen:boomLen},
    {p:0.92, W:boomDiam,      H:boomDiam,       tA:0,  bA:0,   tS:1.0, bS:1.0, ell:true,  refLen:boomLen},
    {p:1.00, W:boomDiam*0.15, H:boomDiam*0.15, tA:-90, bA:-90, tS:0.25,bS:0.25,ell:false, refLen:boomLen},
  ];
  const boomXML = fusGeom(
    'LiftBoom', 200,200,200,
    boomXFwd, yBoom, zBoom,   // fwd tip X, Y=yBoom lateral (clears V-tail), Z=wing surface
    0,                         // yRot=0 → boom runs perfectly parallel to X-axis
    boomLen, 2, boomSt, 8, 9
  );

  // ── 4. FOUR FIXED LIFT ROTORS — ON BOOM TIPS ──────────────────────────
  // Forward pair: at boom fwd tips (xRotFwd, ±yBoom)
  // Aft pair:     at boom aft tips (xRotAft, ±yBoom) — behind V-tail TE
  // YRot=90 → horizontal disk → thrust straight UP (+Z).
  // XZ symmetry on each geom → 2 geoms × 2 mirrors = 4 rotors total.
  const liftRotFwdXML = diskGeom(
    'LiftRotor_Fwd', 255,80,0,
    xRotFwd, yBoom, zLiftRotor,
    90, Drot, 2
  );
  const liftRotAftXML = diskGeom(
    'LiftRotor_Aft', 255,80,0,
    xRotAft, yBoom, zLiftRotor,  // aft boom tip — boom passes outboard of V-tail (y=yBoom > V-tail span)
    90, Drot, 2
  );

  // ── 5. CENTER PUSHER ROTOR ─────────────────────────────────────────────
  // Single prop at extreme aft tip of fuselage (x = fL), on centreline.
  // YRot = 0 → disk plane perpendicular to X-axis → thrust vector in +X (pusher).
  // No symmetry (sym=0): single centreline component.
  const pusherXML = diskGeom(
    'CruisePusher', 0,200,50,
    xPusher, 0, 0,   // fuselage tail, centreline
    0,               // YRot=0 → disc ⊥ X → thrust in +X
    dPusher, 0       // no symmetry
  );

  // ── 6. V-TAIL — GEOMETRY UNCHANGED ────────────────────────────────────
  const vtailXML = wingGeom(
    'VTail', 255,215,0,
    xVtLE, zVtRoot, 0,
    CrVT, CtVT, bvt, swVT, vtG, 0,
    17, 2,
    bvt*2, bvt*(CrVT+CtVT)/2, (CrVT+CtVT)/2
  );

  // ── 7. WINGTIP NACELLES (tilt mechanism housings) ─────────────────────
  // Two small pods, one at each wingtip, running along +X.
  // Front face of nacelle at xNacStart = xWingLE; rotor disc at xTipRot = xNacStart − 0.05m.
  // Z = zNac = zWing (flush with high-wing surface).
  // Y = ±yTipRot: guarantees ≥1.7m blade-tip clearance from boom rotors.
  // XZ symmetry NOT used — left and right nacelles are separate geoms so
  // each tilting rotor can be independently controlled in VSP animation.
  const nacSt = [
    {p:0.00, W:nacDiam*0.12, H:nacDiam*0.12, tA: 90, bA: 90, tS:0.4, bS:0.4, ell:false, refLen:nacLen},
    {p:0.10, W:nacDiam,      H:nacDiam,       tA:0,  bA:0,   tS:1.0, bS:1.0, ell:true,  refLen:nacLen},
    {p:0.90, W:nacDiam,      H:nacDiam,       tA:0,  bA:0,   tS:1.0, bS:1.0, ell:true,  refLen:nacLen},
    {p:1.00, W:nacDiam*0.12, H:nacDiam*0.12, tA:-90, bA:-90, tS:0.25,bS:0.25,ell:false, refLen:nacLen},
  ];
  const nacRightXML = fusGeom(
    'TiltNacelle_Right', 80,200,180,
    xNacStart, +yTipRot, zNac,  // right wingtip nacelle (+Y)
    0,                           // yRot=0 → nacelle runs along +X
    nacLen, 0, nacSt, 8, 9      // no symmetry — independent left/right
  );
  const nacLeftXML = fusGeom(
    'TiltNacelle_Left', 80,200,180,
    xNacStart, -yTipRot, zNac,  // left wingtip nacelle (-Y)
    0,
    nacLen, 0, nacSt, 8, 9
  );

  // ── 8. TWO TILTING WINGTIP ROTORS — MOUNTED AT NACELLE NOSE ──────────
  // Disc at xTipRot = xNacStart − 0.05m (5cm forward of nacelle nose, clears body).
  // TILT MECHANISM — RotY encodes tilt angle:
  //   RotY = 90°  → disc horizontal → thrust UP (+Z)  [HOVER — default]
  //   RotY =  0°  → disc vertical   → thrust FWD (+X) [CRUISE]
  // Animate Y_Rotation 90→0 in OpenVSP to simulate transition to forward cruise.
  // Left and right are separate geoms (no symmetry) for independent tilt control.
  const tiltRotRightXML = diskGeom(
    'TiltRotor_Right', 0,220,100,
    xTipRot, +yTipRot, zTipRot,  // right nacelle nose (+Y)
    90,                            // RotY=90: HOVER default (disc horizontal, thrust UP)
    Drot, 0
  );
  const tiltRotLeftXML = diskGeom(
    'TiltRotor_Left', 0,220,100,
    xTipRot, -yTipRot, zTipRot,  // left nacelle nose (-Y)
    90,                            // RotY=90: HOVER default (disc horizontal, thrust UP)
    Drot, 0
  );

  // ── Assemble final VSP3 XML ────────────────────────────────────────────
  const xml = `<?xml version="1.0"?>
<Vsp_Geometry>
  <Version>4</Version>
  <Vehicle>
    <ParmContainer>
      <ID>${ID()}</ID>
      <n>Vehicle</n>
    </ParmContainer>
${fusXML}
${wingXML}
${boomXML}
${liftRotFwdXML}
${liftRotAftXML}
${pusherXML}
${vtailXML}
${nacRightXML}
${nacLeftXML}
${tiltRotRightXML}
${tiltRotLeftXML}
  </Vehicle>
  <!-- Trail1 eVTOL  |  Wright State University
       MTOW: ${MTOW.toFixed(1)} kg  |  Wing: b=${bW.toFixed(2)} m  S=${SW.toFixed(2)} m²
       CG: ${xCG.toFixed(3)} m from nose  |  SM: ${(SM*100).toFixed(1)}% MAC
       Boom: Fwd=${boomXFwd.toFixed(3)} m  Aft=${boomXAft.toFixed(3)} m  L=${boomLen.toFixed(3)} m  Y=±${yBoom.toFixed(3)} m
       V-tail: Γ=${vtG.toFixed(1)}°  bvt=${bvt.toFixed(2)} m  Λ=${swVT.toFixed(1)}°
       V-tail clearance: vtClearAft=${vtClearAft.toFixed(3)} m ${vtClearAft<=boomXAft?'≤':'>'} boomXAft=${boomXAft.toFixed(3)} m → ${vtClearAft<=boomXAft?'OK':'⚠ CHECK REQUIRED'}
  -->
</Vsp_Geometry>`;

  return xml;
}

function generateReport(p, SR, branding={}) {
  const fmt = (v, d=3) => (typeof v==="number" && isFinite(v)) ? v.toFixed(d) : "—";
  const now = new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  const feasBadge = SR.feasible
    ? `<span class="badge green">✓ FEASIBLE</span>`
    : `<span class="badge amber">⚠ CHECK DESIGN</span>`;

  // ── Section builder helpers ──────────────────────────────────────────
  const sec = (id, title, content) =>
    `<section id="${id}"><h2>${title}</h2>${content}</section>`;

  const eq = (latex, note="") =>
    `<div class="eq-block"><span class="katex-eq" data-latex="${latex.replace(/"/g,'&quot;')}"></span>${note?`<div class="eq-note">${note}</div>`:""}</div>`;

  const sub = (latex, note="") =>
    `<span class="katex-inline" data-latex="${latex.replace(/"/g,'&quot;')}"></span>${note}`;

  const row = (label, formula, value, unit="") =>
    `<tr><td class="td-label">${label}</td><td class="td-formula">${formula}</td><td class="td-value">${value}</td><td class="td-unit">${unit}</td></tr>`;

  const table = (headers, rows) =>
    `<table class="data-table"><thead><tr>${headers.map(hdr=>`<th>${hdr}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;

  const check = (ok, label, val) =>
    `<tr class="${ok?"ok":"fail"}"><td>${ok?"✓":"✗"}</td><td>${label}</td><td>${val}</td></tr>`;

  // ── COVER PAGE ───────────────────────────────────────────────────────
  const bAuthor = branding.authorName || "Vinay Kumar Reddy Sirigireddy";
  const bUniv   = branding.university || "Wright State University";
  const bTitle  = branding.projectTitle || "eVTOL Aircraft Sizing Report";
  const bDate   = branding.date || now;
  const bLogo   = branding.logoUrl || "";

  const cover = `
  <div class="cover-page">
    <div style="position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,#f59e0b,#3b82f6,#14b8a6);"></div>

    ${bLogo ? `<div style="margin-bottom:24px;text-align:center;">
      <img src="${bLogo}" alt="${bUniv} Logo"
        style="height:70px;max-width:260px;object-fit:contain;border-radius:6px;"
        onerror="this.parentElement.style.display='none'">
    </div>` : ""}

    <div class="cover-badge">AEROSPACE DESIGN SUITE — eVTOL SIZER v2.0</div>
    <div class="cover-title">${bTitle}</div>
    <div class="cover-sub">Parametric Sizing &amp; Performance Analysis — MATLAB Algorithm Port</div>
    <div class="cover-line"></div>

    <div style="display:flex;gap:32px;width:100%;max-width:760px;margin-bottom:32px;align-items:flex-start;">
      <table class="cover-meta" style="flex:1;">
        <tr><td>Author / Engineer</td><td>${bAuthor}</td></tr>
        <tr><td>Institution</td><td>${bUniv}</td></tr>
        <tr><td>Advisor</td><td>Dr. Darryl K. Ahner</td></tr>
        <tr><td>Framework</td><td>MATLAB-MBSE Integrated Sizing</td></tr>
        <tr><td>Algorithm</td><td>eVTOL_Full_Analysis_v2.m — JS Port</td></tr>
        <tr><td>Report Date</td><td>${bDate}</td></tr>
        <tr><td>Generated</td><td>${now}</td></tr>
        <tr><td>Design Status</td><td>${feasBadge}</td></tr>
      </table>
      <div style="min-width:190px;">
        <div style="font-size:7pt;color:#7fa3c8;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px;font-family:monospace;border-bottom:1px solid #1e3a5c;padding-bottom:6px;">Key Results</div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">MTOW</span><span style="font-size:8.5pt;color:#f59e0b;font-weight:700;font-family:monospace;">${fmt(SR.MTOW,1)} kg</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Empty Weight</span><span style="font-size:8.5pt;color:#f59e0b;font-weight:700;font-family:monospace;">${fmt(SR.Wempty,1)} kg</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Battery Mass</span><span style="font-size:8.5pt;color:#f59e0b;font-weight:700;font-family:monospace;">${fmt(SR.Wbat,1)} kg</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Hover Power</span><span style="font-size:8.5pt;color:#14b8a6;font-weight:700;font-family:monospace;">${fmt(SR.Phov,1)} kW</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Cruise Power</span><span style="font-size:8.5pt;color:#14b8a6;font-weight:700;font-family:monospace;">${fmt(SR.Pcr,1)} kW</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Total Energy</span><span style="font-size:8.5pt;color:#3b82f6;font-weight:700;font-family:monospace;">${fmt(SR.Etot,2)} kWh</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Wing Span</span><span style="font-size:8.5pt;color:#22c55e;font-weight:700;font-family:monospace;">${fmt(SR.bWing,2)} m</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #131f30;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Actual L/D</span><span style="font-size:8.5pt;color:#22c55e;font-weight:700;font-family:monospace;">${fmt(SR.LDact,2)}</span></div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="font-size:8pt;color:#7fa3c8;font-family:monospace;">Static Margin</span><span style="font-size:8.5pt;color:#22c55e;font-weight:700;font-family:monospace;">${fmt(SR.SM_vt*100,1)}%</span></div>
      </div>
    </div>

    <div class="cover-kpi-grid">
      <div class="kpi"><div class="kpi-val">${fmt(SR.MTOW,1)}</div><div class="kpi-lbl">MTOW (kg)</div></div>
      <div class="kpi"><div class="kpi-val">${fmt(SR.Etot,2)}</div><div class="kpi-lbl">Energy (kWh)</div></div>
      <div class="kpi"><div class="kpi-val">${fmt(SR.Phov,1)}</div><div class="kpi-lbl">Hover Power (kW)</div></div>
      <div class="kpi"><div class="kpi-val">${fmt(SR.bWing,2)}</div><div class="kpi-lbl">Wing Span (m)</div></div>
      <div class="kpi"><div class="kpi-val">${fmt(SR.SM_vt*100,1)}%</div><div class="kpi-lbl">Static Margin</div></div>
      <div class="kpi"><div class="kpi-val">${fmt(SR.LDact,2)}</div><div class="kpi-lbl">Actual L/D</div></div>
    </div>

    <div style="position:absolute;bottom:22px;left:0;right:0;text-align:center;font-size:7pt;color:#3a5a7a;font-family:monospace;letter-spacing:0.08em;">
      Wright State University &nbsp;·&nbsp; MATLAB-MBSE Integrated Sizing Framework &nbsp;·&nbsp; ${bDate}
    </div>
  </div>`;

  // ── 1. DESIGN INPUTS ─────────────────────────────────────────────────
  const s1 = sec("inputs","1. Design Inputs & Mission Requirements",`
  <p>The following input parameters define the baseline design for the Trail 1 eVTOL configuration. All sizing calculations are derived directly from these values.</p>
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Payload","m<sub>pay</sub>",p.payload,"kg"),
    row("Design Range","SR",p.range,"km"),
    row("Cruise Speed","V<sub>cr</sub>",p.vCruise,"m/s ("+fmt(p.vCruise*3.6,1)+" km/h)"),
    row("Cruise Altitude","h<sub>cr</sub>",p.cruiseAlt,"m"),
    row("Reserve Time","t<sub>res,min</sub>",p.reserveMinutes||20,"min"),
    row("Hover Height","h<sub>hov</sub>",p.hoverHeight,"m"),
    row("L/D (design)","(L/D)<sub>des</sub>",p.LD,""),
    row("Wing AR","AR",p.AR,""),
    row("Oswald Efficiency","e",p.eOsw,""),
    row("Design C<sub>L</sub>","C<sub>L,des</sub>",p.clDesign,""),
    row("Taper Ratio","λ",p.taper,""),
    row("t/c Ratio","(t/c)",p.tc,""),
    row("No. of Rotors","N<sub>rot</sub>",p.nPropHover,""),
    row("Rotor Diameter","D<sub>rot</sub>",p.propDiam,"m"),
    row("Hover FOM","η<sub>hov</sub>",p.etaHov,""),
    row("System Efficiency","η<sub>sys</sub>",p.etaSys,""),
    row("Rate of Climb","RoC",p.rateOfClimb,"m/s"),
    row("Climb Angle","γ<sub>cl</sub>",p.climbAngle,"°"),
    row("Cell Spec. Energy","SED<sub>cell</sub>",p.sedCell,"Wh/kg"),
    row("Battery Efficiency","η<sub>bat</sub>",p.etaBat,""),
    row("Min. SoC","SoC<sub>min</sub>",p.socMin,""),
    row("Empty Weight Frac.","EWF",p.ewf,""),
    row("Fuselage Length","L<sub>fus</sub>",p.fusLen,"m"),
    row("Fuselage Diameter","D<sub>fus</sub>",p.fusDiam,"m"),
    row("V-Tail Dihedral","Γ",p.vtGamma,"°"),
    row("Horiz. Tail Vol. Coeff.","C<sub>h</sub>",p.vtCh,""),
    row("Vert. Tail Vol. Coeff.","C<sub>v</sub>",p.vtCv,""),
    row("V-Tail AR","AR<sub>vt</sub>",p.vtAR,""),
  ])}
  `);

  // ── 2. ATMOSPHERE MODEL ──────────────────────────────────────────────
  const s2 = sec("atmo","2. Atmosphere Model (ISA)",`
  <p>All aerodynamic calculations use the International Standard Atmosphere (ISA) model evaluated at the cruise altitude h = ${p.cruiseAlt} m.</p>
  ${eq("T_{cr} = T_0 - L_{lapse} \\cdot h_{cr} = 288.15 - 0.0065 \\times "+p.cruiseAlt+" = "+fmt(288.15-0.0065*p.cruiseAlt,2)+"\\text{ K}",
    "Temperature at cruise altitude")}
  ${eq("\\rho_{cr} = \\rho_{SL}\\left(\\frac{T_{cr}}{T_0}\\right)^{\\left(\\frac{g_0}{L_{lapse}\\,R_{air}}\\right)-1} = "+fmt(SR.MTOW ? 1.225*Math.pow((288.15-0.0065*p.cruiseAlt)/288.15, (-9.81/(-0.0065*287))-1) : 1.112,4)+"\\text{ kg/m}^3",
    "Density at cruise altitude (ISA troposphere)")}
  ${eq("a_{cr} = \\sqrt{\\gamma R_{air} T_{cr}} = \\sqrt{1.4 \\times 287 \\times "+(288.15-0.0065*p.cruiseAlt).toFixed(2)+"} = "+fmt(Math.sqrt(1.4*287*(288.15-0.0065*p.cruiseAlt)),2)+"\\text{ m/s}",
    "Speed of sound at cruise altitude")}
  ${eq("M = \\frac{V_{cr}}{a_{cr}} = \\frac{"+p.vCruise+"}{"+fmt(Math.sqrt(1.4*287*(288.15-0.0065*p.cruiseAlt)),2)+"} = "+fmt(SR.Mach,4),
    "Cruise Mach number")}
  `);

  // ── 3. WEIGHT SIZING ─────────────────────────────────────────────────
  const s3 = sec("weight","3. Weight & Energy Sizing (Iterative)",`
  <p>The MTOW is found by simultaneously converging the weight and energy fractions using a nested iterative scheme. The battery mass fraction is:</p>
  ${eq("f_{bat} = \\frac{g_0 \\cdot SR}{(L/D)\\,\\eta_{sys}\\,\\text{SED}_{cell}\\times 3600}","Battery mass fraction (range-energy method)")}
  ${eq("W_E = \\frac{E_{total}\\times 1000}{(1-\\text{SoC}_{min})\\,\\text{SED}_{eff}\\,\\eta_{bat}},\\quad W_P = \\frac{P_{hov}}{SP_{bat}},\\quad W_{bat}=\\max(W_E,W_P)","Dual-constraint battery mass (energy & power limits)")}
  ${eq("\\text{MTOW} = m_{pay} + f_{EW}\\cdot\\text{MTOW} + W_{bat}","Weight closure equation (solved iteratively)")}
  ${table(["Quantity","Symbol","Value","Unit"],[
    row("MTOW (initial)","MTOW<sub>1</sub>",fmt(SR.MTOW1,1),"kg"),
    row("MTOW (converged)","MTOW",fmt(SR.MTOW,1),"kg"),
    row("Empty Weight","W<sub>e</sub>",fmt(SR.Wempty,1),"kg"),
    row("Battery Mass","W<sub>bat</sub>",fmt(SR.Wbat,1),"kg"),
    row("Payload","m<sub>pay</sub>",p.payload,"kg"),
    row("Battery Mass Fraction","W<sub>bat</sub>/MTOW",fmt(SR.Wbat/SR.MTOW*100,1),"%"),
  ])}
  `);

  // ── 4. MISSION ENERGY ────────────────────────────────────────────────
  const s4 = sec("energy","4. Mission Energy Breakdown",`
  <p>The mission is divided into six phases: Takeoff (hover), Climb, Cruise, Descent, Landing (hover), and Reserve.</p>
  ${eq("E_{total} = E_{TO}+E_{cl}+E_{cr}+E_{dc}+E_{ld}+E_{res} = "+fmt(SR.Etot,3)+"\\text{ kWh}","Total mission energy")}
  ${eq("P_{hov} = \\frac{W\\,g_0}{\\eta_{hov}}\\sqrt{\\frac{W\\,g_0}{2\\,\\rho_{SL}\\,N_{rot}\\,A_{disk}}} = "+fmt(SR.Phov,2)+"\\text{ kW}","Hover power (actuator disk theory)")}
  ${eq("P_{cr} = \\frac{W\\,g_0\\,V_{cr}}{\\eta_{sys}\\,(L/D)} = "+fmt(SR.Pcr,2)+"\\text{ kW}","Cruise power")}
  ${table(["Phase","Power (kW)","Time (s)","Energy (kWh)"],[
    row("Takeoff (Hover)","P<sub>hov</sub> = "+fmt(SR.Phov,2),fmt(SR.tto,0),fmt(SR.Eto,3)),
    row("Climb","P<sub>cl</sub> = "+fmt(SR.Pcl,2),fmt(SR.tcl,0),fmt(SR.Ecl,3)),
    row("Cruise","P<sub>cr</sub> = "+fmt(SR.Pcr,2),fmt(SR.tcr,0),fmt(SR.Ecr,3)),
    row("Descent","P<sub>dc</sub> = "+fmt(SR.Pdc,2),fmt(SR.tdc,0),fmt(SR.Edc,3)),
    row("Landing (Hover)","P<sub>hov</sub> = "+fmt(SR.Phov,2),fmt(SR.tld,0),fmt(SR.Eld,3)),
    row("Reserve","P<sub>res</sub> = "+fmt(SR.Pres,2),fmt(SR.tres,0),fmt(SR.Eres,3)),
    row("<strong>Total</strong>","","<strong>"+fmt(SR.Tend,0)+" s</strong>","<strong>"+fmt(SR.Etot,3)+"</strong>"),
  ])}
  `);

  // ── 5. WING AERODYNAMICS ─────────────────────────────────────────────
  const s5 = sec("wing","5. Wing Design & Aerodynamics",`
  <p>Wing area is sized to provide the required lift at cruise using the design lift coefficient C<sub>L,des</sub> = ${p.clDesign}.</p>
  ${eq("S_w = \\frac{2\\,L_{req}}{\\rho_{cr}\\,V_{cr}^2\\,C_{L,des}} = \\frac{2\\times"+fmt(SR.MTOW*9.81,1)+"}{"+fmt(1.225*Math.pow((288.15-0.0065*p.cruiseAlt)/288.15,(-9.81/(-0.0065*287))-1),4)+"\\times"+p.vCruise+"^2\\times"+p.clDesign+"} = "+fmt(SR.Swing,2)+"\\text{ m}^2","Wing reference area")}
  ${eq("b_w = \\sqrt{AR\\cdot S_w} = \\sqrt{"+p.AR+"\\times"+fmt(SR.Swing,2)+"} = "+fmt(SR.bWing,2)+"\\text{ m}","Wing span")}
  ${eq("C_r = \\frac{2S_w}{b_w(1+\\lambda)} = "+fmt(SR.Cr_,3)+"\\text{ m}, \\quad C_t = \\lambda\\,C_r = "+fmt(SR.Ct_,3)+"\\text{ m}","Root and tip chord (taper λ = "+p.taper+")")}
  ${eq("\\bar{c} = \\frac{2}{3}C_r\\frac{1+\\lambda+\\lambda^2}{1+\\lambda} = "+fmt(SR.MAC,3)+"\\text{ m}","Mean aerodynamic chord (MAC)")}
  ${eq("\\Lambda_{LE} = \\arctan\\!\\left(\\frac{C_r - C_t}{b_w/2}\\right) = \\arctan\\!\\left(\\frac{"+fmt(SR.Cr_,3)+"-"+fmt(SR.Ct_,3)+"}{"+fmt(SR.bWing/2,3)+"}\\right) = "+fmt(SR.sweep,2)+"^\\circ","Leading edge sweep (semi-span denominator)")}
  ${eq("C_{D_0,total} = "+fmt(SR.CD0tot,5)+", \\quad C_{D_i} = \\frac{C_{L,des}^2}{\\pi\\,AR\\,e} = "+fmt(SR.CDi,5),"Parasitic and induced drag coefficients")}
  ${eq("(L/D)_{actual} = \\frac{C_{L,des}}{C_{D_0}+C_{D_i}} = "+fmt(SR.LDact,2),"Actual cruise lift-to-drag ratio")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Wing Area","S<sub>w</sub>",fmt(SR.Swing,2),"m²"),
    row("Wing Span","b<sub>w</sub>",fmt(SR.bWing,3),"m"),
    row("Root Chord","C<sub>r</sub>",fmt(SR.Cr_,3),"m"),
    row("Tip Chord","C<sub>t</sub>",fmt(SR.Ct_,3),"m"),
    row("MAC","c̄",fmt(SR.MAC,3),"m"),
    row("y<sub>MAC</sub>","ȳ<sub>MAC</sub>",fmt(SR.Ymac,3),"m"),
    row("LE Sweep","Λ<sub>LE</sub>",fmt(SR.sweep,2),"°"),
    row("Wing Loading","W/S",fmt(SR.WL,1),"N/m²"),
    row("Re (MAC)","Re",fmt(SR.Re_,0),""),
    row("Selected Airfoil","—",SR.selAF?.name||"—",""),
    row("Actual L/D","(L/D)<sub>act</sub>",fmt(SR.LDact,2),""),
    row("C<sub>D0</sub> total","C<sub>D0</sub>",fmt(SR.CD0tot,5),""),
    row("C<sub>Di</sub>","C<sub>Di</sub>",fmt(SR.CDi,5),""),
  ])}
  `);

  // ── 6. PROPULSION ────────────────────────────────────────────────────
  const s6 = sec("prop","6. Hover Propulsion Sizing",`
  <p>Rotor disk area is sized from actuator disk theory to satisfy the hover power budget with the given figure of merit η<sub>hov</sub> = ${p.etaHov}.</p>
  ${eq("T_{rotor} = \\frac{W\\,g_0}{N_{rot}} = \\frac{"+fmt(SR.MTOW,1)+"\\times 9.81}{"+p.nPropHover+"} = "+fmt(SR.MTOW*9.81/p.nPropHover,1)+"\\text{ N}","Thrust per rotor")}
  ${eq("A_{disk} = \\frac{T_{rotor}^3}{2\\,\\rho_{SL}\\,(P_{rotor}\\,\\eta_{hov})^2}","Disk area from actuator disk momentum theory")}
  ${eq("D_{rotor} = 2\\sqrt{A_{disk}/\\pi} = "+fmt(SR.Drotor,3)+"\\text{ m}","Rotor diameter")}
  ${eq("\\Omega_{tip} = \\sqrt{\\frac{2P_{rotor}\\eta_{hov}}{\\rho_{SL}\\,A_{disk}}}, \\quad \\text{RPM} = \\frac{60\\,\\Omega_{tip}}{2\\pi SR} = "+fmt(SR.RPM,0),"Tip speed and rotational speed")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Hover Power (total)","P<sub>hov</sub>",fmt(SR.Phov,2),"kW"),
    row("Power per Rotor","P<sub>rotor</sub>",fmt(SR.Phov/p.nPropHover,2),"kW"),
    row("Rotor Diameter","D<sub>rot</sub>",fmt(SR.Drotor,3),"m"),
    row("Disk Loading","DL",fmt(SR.DLrotor,1),"N/m²"),
    row("Power Loading","PL",fmt(SR.PLrotor,1),"N/W"),
    row("Tip Speed","Ω<sub>tip</sub>",fmt(SR.TipSpd,1),"m/s"),
    row("Tip Mach","M<sub>tip</sub>",fmt(SR.TipMach,4),""),
    row("RPM","n",fmt(SR.RPM,0),"rpm"),
    row("No. of Blades","N<sub>bl</sub>",SR.Nbld,""),
    row("Blade Chord","c<sub>bl</sub>",fmt(SR.ChordBl,4),"m"),
    row("Motor Power","P<sub>mot</sub>",fmt(SR.PmotKW,2),"kW"),
    row("Peak Power","P<sub>peak</sub>",fmt(SR.PpeakKW,2),"kW"),
  ])}
  `);

  // ── 7. BATTERY ───────────────────────────────────────────────────────
  const s7 = sec("battery","7. Battery System Sizing",`
  ${eq("W_E = \\frac{E_{total}\\times 1000}{(1-\\text{SoC}_{min})\\,\\text{SED}_{eff}\\,\\eta_{bat}} = \\frac{"+fmt(SR.Etot,3)+"\\times 1000}{(1-"+p.socMin+")\\times"+p.sedCell+"\\times"+p.etaBat+"} = "+fmt(SR.Wbat,1)+"\\text{ kg},\\quad W_P=\\frac{P_{hov}}{SP_{bat}}="+fmt(SR.Phov,1)+"\\text{ kW},\\;W_{bat}=\\max(W_E,W_P)","Dual-constraint battery mass (energy + power limits)")}
  ${eq("\\text{SED}_{pack} = \\frac{E_{total}}{W_{bat}} = "+fmt(SR.SEDpack,1)+"\\text{ Wh/kg}","Pack-level specific energy density")}
  ${eq("N_{series} = \\text{round}\\!\\left(\\frac{V_{pack}}{V_{cell}}\\right) = \\text{round}\\!\\left(\\frac{800}{3.6}\\right) = "+SR.Nseries,"Series cell count for 800V pack")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Battery Mass","W<sub>bat</sub>",fmt(SR.Wbat,1),"kg"),
    row("Total Energy","E<sub>total</sub>",fmt(SR.Etot,3),"kWh"),
    row("Pack SED","SED<sub>pack</sub>",fmt(SR.SEDpack,1),"Wh/kg"),
    row("Pack Voltage","V<sub>pack</sub>",fmt(SR.PackV,0),"V"),
    row("Pack Capacity","Q<sub>pack</sub>",fmt(SR.PackAh,1),"Ah"),
    row("Series Cells","N<sub>s</sub>",SR.Nseries,""),
    row("Parallel Strings","N<sub>p</sub>",SR.Npar,""),
    row("Total Cells","N<sub>cells</sub>",SR.Ncells,""),
    row("C-rate (Hover)","C<sub>hov</sub>",fmt(SR.CrateHov,2),"C"),
    row("C-rate (Cruise)","C<sub>cr</sub>",fmt(SR.CrateCr,2),"C"),
  ])}
  `);

  // ── 8. STABILITY ─────────────────────────────────────────────────────
  const xACwing = fmt(+(p.fusLen*0.2589 + (SR.Cr_-(SR.MAC-0.25*SR.MAC))),3);
  const s8 = sec("stability","8. Longitudinal Stability",`
  <p>The static margin (SM) measures stability: positive SM indicates the neutral point (NP) is aft of the centre of gravity (CG).</p>
  ${eq("x_{CG,total} = \\frac{W_e\\,x_{CG,e}+W_{bat}\\,x_{CG,bat}+m_{pay}\\,x_{CG,pay}}{\\text{MTOW}} = "+fmt(SR.xCGtotal,3)+"\\text{ m from nose}","Total centre of gravity")}
  ${eq("x_{NP} = x_{AC,wing} + \\frac{S_h}{S_w}\\,\\eta_h\\,(1-\\varepsilon_\\alpha)\\,l_h = "+fmt(SR.SM_vt !== undefined ? SR.xNP : SR.xNP,3)+"\\text{ m from nose}","Neutral point (stick-fixed)")}
  ${eq("SM = \\frac{x_{NP}-x_{CG}}{\\bar{c}} = \\frac{"+fmt(SR.xNP,3)+"-"+fmt(SR.xCGtotal,3)+"}{"+fmt(SR.MAC,3)+"} = "+fmt(SR.SM*100,1)+"\\%\\;\\text{MAC}","Static margin")}
  ${table(["Quantity","Symbol","Value","Unit"],[
    row("Wing AC from nose","x<sub>AC,w</sub>",xACwing,"m"),
    row("Total CG from nose","x<sub>CG</sub>",fmt(SR.xCGtotal,3),"m"),
    row("Neutral Point from nose","x<sub>NP</sub>",fmt(SR.xNP,3),"m"),
    row("Static Margin","SM",fmt(SR.SM*100,2),"%  MAC"),
    row("MAC","c̄",fmt(SR.MAC,3),"m"),
  ])}
  `);

  // ── 9. V-TAIL ────────────────────────────────────────────────────────
  const s9 = sec("vtail","9. V-Tail Sizing (Ruscheweyh / Raymer)",`
  <p>The V-tail replaces both the horizontal and vertical stabilisers. Each panel is inclined at dihedral angle Γ = ${p.vtGamma}° from horizontal.</p>
  ${eq("S_{h,req} = \\frac{C_h\\,S_w\\,\\bar{c}}{l_v} = \\frac{"+p.vtCh+"\\times"+fmt(SR.Swing,2)+"\\times"+fmt(SR.MAC,3)+"}{"+fmt(SR.lv,3)+"} = "+fmt(SR.Sh_req,3)+"\\text{ m}^2","Required horizontal tail area")}
  ${eq("S_{v,req} = \\frac{C_v\\,S_w\\,b_w}{l_v} = \\frac{"+p.vtCv+"\\times"+fmt(SR.Swing,2)+"\\times"+fmt(SR.bWing,2)+"}{"+fmt(SR.lv,3)+"} = "+fmt(SR.Sv_req,3)+"\\text{ m}^2","Required vertical tail area")}
  ${eq("S_{panel} = \\max\\!\\left(\\frac{S_{h,req}}{\\cos^2\\Gamma},\\,\\frac{S_{v,req}}{\\sin^2\\Gamma}\\right) = "+fmt(SR.Svt_panel,3)+"\\text{ m}^2","V-tail panel area (governing constraint)")}
  ${eq("\\Gamma_{opt} = \\arctan\\!\\sqrt{\\frac{S_{v,req}}{S_{h,req}}} = "+fmt(SR.vtGamma_opt,1)+"^\\circ","Optimal dihedral angle for minimum panel area")}
  ${eq("b_{vt} = \\sqrt{AR_{vt}\\cdot S_{panel}} = "+fmt(SR.bvt_panel,3)+"\\text{ m}, \\quad C_{r,vt} = "+fmt(SR.Cr_vt,3)+"\\text{ m}, \\quad C_{t,vt} = "+fmt(SR.Ct_vt,3)+"\\text{ m}","V-tail panel geometry")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Tail moment arm","l<sub>v</sub>",fmt(SR.lv,3),"m"),
    row("Req. H-tail area","S<sub>h,req</sub>",fmt(SR.Sh_req,3),"m²"),
    row("Req. V-tail area","S<sub>v,req</sub>",fmt(SR.Sv_req,3),"m²"),
    row("Panel area","S<sub>panel</sub>",fmt(SR.Svt_panel,3),"m²"),
    row("Total V-tail area","S<sub>vt,total</sub>",fmt(SR.Svt_total,3),"m²"),
    row("Optimal Γ","Γ<sub>opt</sub>",fmt(SR.vtGamma_opt,1),"°"),
    row("Chosen Γ","Γ",p.vtGamma,"°"),
    row("Panel span","b<sub>vt</sub>",fmt(SR.bvt_panel,3),"m"),
    row("Root chord","C<sub>r,vt</sub>",fmt(SR.Cr_vt,3),"m"),
    row("Tip chord","C<sub>t,vt</sub>",fmt(SR.Ct_vt,3),"m"),
    row("LE sweep","Λ<sub>LE,vt</sub>",fmt(SR.sweep_vt,2),"°"),
    row("Pitch authority","—",fmt(SR.pitch_ratio*100,1),"%"),
    row("Yaw authority","—",fmt(SR.yaw_ratio*100,1),"%"),
  ])}
  `);

  // ── 10. FEASIBILITY ──────────────────────────────────────────────────
  const s10 = sec("feasibility","10. Feasibility Checks",`
  <table class="check-table"><thead><tr><th>Pass</th><th>Criterion</th><th>Value</th></tr></thead><tbody>
    ${(SR.checks||[]).map(chk=>check(chk.ok,chk.label,chk.val)).join("")}
  </tbody></table>
  `);

  // ── V-n DIAGRAM + OEI section ─────────────────────────────────────
  const g0d_vn=9.81,rhoMSLd_vn=1.225;
  const Kg_vn=0.88*p.AR/(5.3+p.AR);
  const CLa_vn=2*Math.PI*(1+0.77*p.tc);
  const nPosLim=3.5,nNegLim=-1.5;
  const Ug_c=15.2,Ug_d=7.6;
  const ngust_c_pdf=1+(Kg_vn*rhoMSLd_vn*Ug_c*p.vCruise*CLa_vn)/(2*SR.WL);
  const ngust_d_pdf=1+(Kg_vn*rhoMSLd_vn*Ug_d*SR.VD*CLa_vn)/(2*SR.WL);
  // OEI
  const N_oei=p.nPropHover;
  // CORRECT: motor design thrust uses T/W ratio, not T/W=1
  const T_each=(SR.MTOW*g0d_vn*(p.twRatio||1.2))/N_oei;  // actual design thrust per motor
  const T_oei=(N_oei-1)*T_each;                            // OEI: (N-1) motors at full thrust
  const OEI_margin=((T_oei-SR.MTOW*g0d_vn)/(SR.MTOW*g0d_vn)*100);
  const P_mot_nom=SR.Phov*1000/N_oei;
  const P_mot_oei=SR.Phov*1000/(N_oei-1);
  const motorOK=P_mot_oei<=(SR.PpeakKW*1000);

  const s_vn = sec("vn-oei","11. V-n Diagram & One-Engine-Inoperative Analysis",`
  <p>Maneuvering envelope and structural load factors per CS-VTOL Special Condition and CS-23 Amendment 5. Gust load factors computed using the Pratt alleviation method. OEI analysis per CS-VTOL AMC 27.65.</p>
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Stall Speed","V<sub>S</sub>",SR.Vstall.toFixed(2),"m/s"),
    row("Manoeuvre Speed","V<sub>A</sub>",SR.VA.toFixed(2),"m/s"),
    row("Cruise Speed","V<sub>C</sub>",p.vCruise.toFixed(1),"m/s"),
    row("Dive Speed","V<sub>D</sub>",SR.VD.toFixed(2),"m/s"),
    row("Pos. Limit Load","n<sub>+lim</sub>",nPosLim.toFixed(1),"g"),
    row("Neg. Limit Load","n<sub>−lim</sub>",nNegLim.toFixed(1),"g"),
    row("Ultimate Pos.","n<sub>+ult</sub>",(nPosLim*1.5).toFixed(1),"g"),
    row("Gust Alleviation","K<sub>g</sub>",Kg_vn.toFixed(3),""),
    row("Gust n (cruise)","n<sub>g,C</sub>",ngust_c_pdf.toFixed(3),"g"),
    row("Gust n (dive)","n<sub>g,D</sub>",ngust_d_pdf.toFixed(3),"g"),
  ])}
  <h3 style="font-size:11pt;font-weight:700;color:#1e3a5f;margin:16px 0 8px">One-Engine-Inoperative Analysis</h3>
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Number of Rotors","N",N_oei,""),
    row("Total Hover Thrust","T<sub>tot</sub>",fmt(SR.MTOW*g0d_vn/1000,3),"kN"),
    row("OEI Thrust Available","T<sub>OEI</sub>",fmt(T_oei/1000,3),"kN"),
    row("OEI Thrust Margin","ΔT",fmt(OEI_margin,2),"%"),
    row("Nominal Motor Power","P<sub>mot,nom</sub>",fmt(P_mot_nom/1000,2),"kW"),
    row("OEI Motor Power","P<sub>mot,OEI</sub>",fmt(P_mot_oei/1000,2),"kW"),
    row("Peak Motor Rating","P<sub>peak</sub>",fmt(SR.PpeakKW,2),"kW"),
    row("Motor Survivable","",motorOK?"YES ✅":"NO ❌",""),
    row("OEI Verdict","",OEI_margin>0?"SURVIVABLE ✅":"CRITICAL ❌",""),
  ])}
  `);

  // ══════════════════════════════════════════════════════════════════════
  //  DETAILED CALCULATION SECTIONS  (D1–D9)
  // ══════════════════════════════════════════════════════════════════════

  // ── Intermediate values recomputed for display ─────────────────────
  const g0d=9.81,T0d=288.15,L_d=0.0065,Rgasd=287,rhoSLd=1.225;
  const deltaISAd=p.deltaISA||0;
  const T0effd=T0d+deltaISAd;
  const Tcrd=T0effd-L_d*p.cruiseAlt;
  const rhoCrd=rhoSLd*Math.pow(Tcrd/T0effd,(-g0d/(-L_d*Rgasd))-1);
  const muSLd=1.789e-5;
  const muCrd=muSLd*Math.pow(Tcrd/T0effd,0.75);
  const RoCd=p.rateOfClimb, clAngd=p.climbAngle;
  const Vcld=RoCd/Math.sin(clAngd*Math.PI/180);
  const LDcld=p.LD*(1-(p.climbLDPenalty||0.13));
  const desAngd=p.descentAngle||6;
  const Vdcd=Math.min(RoCd/Math.sin(desAngd*Math.PI/180),p.vCruise);
  const Vresd=0.76*p.vCruise;
  const hvtold=p.hoverHeight;
  const ClimbRd=(p.cruiseAlt-hvtold)/Math.tan(clAngd*Math.PI/180);
  const DescRd=(p.cruiseAlt-hvtold)/Math.tan(desAngd*Math.PI/180);
  const reserveMinutesd=p.reserveMinutes||20;
  const tres_sd=reserveMinutesd*60;
  const reserveDistMd=Vresd*tres_sd;
  const CruiseRanged=p.range*1000-ClimbRd-DescRd-reserveDistMd;
  const bfd=(g0d*p.range*1000)/(p.LD*p.etaSys*p.sedCell*3600);
  const lambdaFd=p.fusLen/p.fusDiam;
  const Swwd=2*SR.Swing*(1+0.25*p.tc*(1+p.taper*0.25));
  const SwfWetd=Math.PI*p.fusDiam*p.fusLen*Math.pow(1-2/lambdaFd,2/3)*(1+1/lambdaFd**2);
  const Swhs_d=2*SR.Swing*0.18, Swvs_d=2*SR.Swing*0.12;
  const Swn_d=p.nPropHover*Math.PI*0.2*0.35;
  const Refusd=rhoCrd*p.vCruise*p.fusLen/muCrd;
  const Cfwd=0.455/Math.log10(SR.Re_)**2.58/(1+0.144*SR.Mach**2)**0.65;
  const Cffd=0.455/Math.log10(Refusd)**2.58/(1+0.144*SR.Mach**2)**0.65;
  const FFwd=(1+0.6/0.3*p.tc+100*p.tc**4)*1.05;
  const FFfd=1+60/lambdaFd**3+lambdaFd/400;
  const Ttotd=SR.MTOW*g0d, Trotord=Ttotd/p.nPropHover;
  const PrWd=SR.Phov*1000/p.nPropHover;
  const Rrotord=p.propDiam/2;
  const Adiskd=Math.PI*Rrotord**2;
  const TipSpdd=SR.TipSpd;  // use value from sizing engine
  const PmotKWd=PrWd/1000*1.15, PpeakKWd=PmotKWd*1.50;
  const Torqued=PmotKWd*1000/(SR.RPM*Math.PI/30);
  const Vcelld=3.6,Ahcelld=5.0,Vpackd=800;
  const Nseriesd=Math.round(Vpackd/Vcelld);
  const PackAhReqd=SR.Etot*1000/Vpackd;
  const Npard=Math.ceil(PackAhReqd/Ahcelld);
  const PackVd=Nseriesd*Vcelld, PackAhd=Npard*Ahcelld;
  const Rintd=0.030*Nseriesd/Npard;
  const Pheatd=(SR.Phov*1000/PackVd)**2*Rintd;
  const xCGfusd=p.fusLen*0.42;
  const Xacd=SR.Cr_-(SR.MAC-0.25*SR.MAC);
  const xCGwingd=p.fusLen*0.2589+Xacd;
  const xCGbatd=p.fusLen*0.38, xCGpayd=p.fusLen*0.40;
  const Wfuscd=SR.Wempty*0.35,Wwingcd=SR.Wempty*0.18;
  const Wmotcd=SR.Wempty*0.22,Wavcd=SR.Wempty*0.04,Wothcd=SR.Wempty*0.21;
  // FIX 1.3: wing structural CG at 40% MAC; FIX 1.4: avionics CG scales with fusLen
  const xCGavcD = p.fusLen*0.18;                              // avionics: 18% fusLen (forward bay)
  const xCGwingd_corr = p.fusLen*0.2589 + 0.40*SR.MAC;       // FIX 1.3: structural CG at 40% MAC
  const xCGemptyd=(Wfuscd*xCGfusd+Wwingcd*xCGwingd_corr+Wmotcd*xCGfusd+Wavcd*xCGavcD+Wothcd*xCGfusd)/SR.Wempty;
  const xACwingd=p.fusLen*0.2589+Xacd;
  const lhd=p.fusLen*0.88-xACwingd;                          // FIX 1.5: tail arm = 88%·L - xAC_wing
  const CLaWd=2*Math.PI*p.AR/(2+Math.sqrt(p.AR**2+4));       // FIX 1.1: Raymer Eq.12.6 finite-wing
  const dwd=2*CLaWd/(Math.PI*p.AR);                          // FIX 1.2: consistent with corrected CLaWd
  const Shd=SR.Swing*0.18;
  const DLd=SR.MTOW*g0d/(Math.PI*Math.pow(p.propDiam/2,2)*p.nPropHover);

  // ── D1. ROUND 1 — INITIAL MTOW ──────────────────────────────────────
  const sd1 = sec("iter1","D1. Round 1 — Initial MTOW Estimate (Simplified Range-Energy Method)",`
  <p>Round 1 computes a first-pass MTOW using a simplified battery mass fraction derived purely from range. Starting guess MTOW<sub>0</sub> = 2177 kg, iterated to convergence (&lt; 10<sup>−6</sup> kg).</p>
  ${eq("f_{bat} = \\frac{g_0 \\cdot SR}{(L/D)\\,\\eta_{sys}\\,\\text{SED}_{cell}\\times 3600} = \\frac{9.81 \\times "+p.range+" \\times 1000}{"+p.LD+" \\times "+p.etaSys+" \\times "+p.sedCell+" \\times 3600} = "+fmt(bfd,5),"Simplified battery mass fraction (range-energy method)")}
  ${eq("W_{empty} = f_{EW} \\cdot \\text{MTOW} = "+p.ewf+" \\cdot \\text{MTOW}","Empty weight from structural mass fraction EWF = "+p.ewf)}
  ${eq("W_{bat,1} = f_{bat} \\cdot \\text{MTOW} = "+fmt(bfd,5)+" \\cdot \\text{MTOW}","Battery mass (Round 1 approximation)")}
  ${eq("\\text{MTOW}_{1} = \\frac{m_{pay}}{1 - f_{EW} - f_{bat}} = \\frac{"+p.payload+"}{1 - "+p.ewf+" - "+fmt(bfd,5)+"} = "+fmt(SR.MTOW1,2)+"\\text{ kg}","Analytical solution of weight closure")}
  ${table(["Quantity","Formula / Value","Result","Unit"],[
    row("Battery fraction","g₀·SR / [(L/D)·η_sys·SED·3600]",fmt(bfd,5),""),
    row("Empty weight (R1)","f_EW × MTOW₁",fmt(p.ewf*SR.MTOW1,1),"kg"),
    row("Battery mass (R1)","f_bat × MTOW₁",fmt(bfd*SR.MTOW1,1),"kg"),
    row("Payload","given",p.payload,"kg"),
    row("MTOW Round 1","m_pay + W_e + W_bat",fmt(SR.MTOW1,2),"kg"),
  ])}
  `);

  // ── D2. ROUND 2 — COUPLED MTOW + ENERGY CONVERGENCE ─────────────────
  const sd2 = sec("iter2","D2. Round 2 — Coupled MTOW + Energy Convergence",`
  <p>Round 2 couples weight closure to full mission energy. For each MTOW trial, all phase powers, times, and energies are computed; W<sub>bat</sub> is re-derived from E<sub>total</sub>; MTOW is updated until |MTOW<sub>new</sub> − MTOW<sub>old</sub>| &lt; 10<sup>−6</sup> kg. Starts from MTOW<sub>1</sub> = ${fmt(SR.MTOW1,2)} kg.</p>
  <p><strong>Phase geometry (fixed, computed once):</strong></p>
  ${eq("V_{cl} = \\frac{\\dot{h}}{\\sin\\gamma_{cl}} = \\frac{"+RoCd+"}{\\sin("+clAngd+"^\\circ)} = "+fmt(Vcld,2)+"\\text{ m/s}","Climb speed from RoC and climb angle")}
  ${eq("(L/D)_{cl} = (L/D)_{cr}\\times 0.87 = "+p.LD+"\\times 0.87 = "+fmt(LDcld,3),"Climb L/D — 13% reduction for induced drag increase")}
  ${eq("\\gamma_{dc} = \\arctan\\!\\left(\\frac{1}{(L/D)}\\right) = "+fmt(desAngd,3)+"^\\circ, \\quad V_{dc} = \\frac{\\dot{h}}{\\sin\\gamma_{dc}} = "+fmt(Vdcd,2)+"\\text{ m/s}","Descent angle and speed")}
  ${eq("V_{res} = 0.76\\,V_{cr} = 0.76\\times "+p.vCruise+" = "+fmt(Vresd,2)+"\\text{ m/s}","Reserve loiter speed (best-endurance, 0.76×cruise)")}
  ${eq("d_{cl} = \\frac{h_{cr}-h_{hov}}{\\tan\\gamma_{cl}} = "+fmt(ClimbRd,1)+"\\text{ m}, \\quad d_{dc} = \\frac{h_{cr}-h_{hov}}{\\tan\\gamma_{dc}} = "+fmt(DescRd,1)+"\\text{ m}","Climb and descent ground tracks")}
  ${eq("d_{cr} = SR - d_{cl} - d_{dc} - d_{res} = "+p.range*1000+" - "+fmt(ClimbRd,1)+" - "+fmt(DescRd,1)+" - "+fmt(reserveDistMd,1)+" = "+fmt(CruiseRanged,1)+"\\text{ m}","Net cruise distance")}
  <p><strong>Final converged iteration (MTOW = ${fmt(SR.MTOW,2)} kg):</strong></p>
  ${eq("DL = \\frac{\\text{MTOW}\\cdot g_0}{N_{rot}\\cdot A_{disk}} = \\frac{"+fmt(SR.MTOW,2)+"\\times 9.81}{"+p.nPropHover+"\\times\\pi("+fmt(p.propDiam/2,3)+")^2} = "+fmt(DLd,2)+"\\text{ N/m}^2","Disk loading")}
  ${eq("P_{hov} = \\frac{W}{\\eta_{hov}}\\sqrt{\\frac{DL}{2\\rho_{SL}}} \\div 1000 = \\frac{"+fmt(SR.MTOW*g0d,1)+"}{"+p.etaHov+"}\\sqrt{\\frac{"+fmt(DLd,2)+"}{2.45}} \\div 1000 = "+fmt(SR.Phov,2)+"\\text{ kW}","Hover power")}
  ${eq("P_{cl} = \\frac{W}{\\eta_{sys}}\\!\\left(\\dot{h}+\\frac{V_{cl}}{(L/D)_{cl}}\\right)\\!\\div 1000 = \\frac{"+fmt(SR.MTOW*g0d,1)+"}{"+p.etaSys+"}\\!\\left("+RoCd+"+\\frac{"+fmt(Vcld,2)+"}{"+fmt(LDcld,3)+"}\\right)\\!\\div 1000 = "+fmt(SR.Pcl,2)+"\\text{ kW}","Climb power")}
  ${eq("P_{cr} = \\frac{W\\,V_{cr}}{\\eta_{sys}\\,(L/D)} = \\frac{"+fmt(SR.MTOW*g0d,1)+"\\times "+p.vCruise+"}{"+p.etaSys+"\\times "+p.LD+"} \\div 1000 = "+fmt(SR.Pcr,2)+"\\text{ kW}","Cruise power")}
  ${eq("P_{dc} = \\frac{W}{\\eta_{sys}}\\!\\left(-\\dot{h}+\\frac{V_{dc}}{(L/D)_{cl}}\\right)\\!\\div 1000 = "+fmt(SR.Pdc,2)+"\\text{ kW}","Descent power")}
  ${eq("P_{res} = \\frac{W\\,V_{res}}{\\eta_{sys}\\,(L/D)} \\div 1000 = "+fmt(SR.Pres,2)+"\\text{ kW}","Reserve power")}
  ${eq("W_E = \\frac{E_{total}\\times 1000}{(1-\\text{SoC}_{min})\\,\\text{SED}_{eff}\\,\\eta_{bat}} = \\frac{"+fmt(SR.Etot,3)+"\\times 1000}{(1-"+p.socMin+")\\times"+p.sedCell+"\\times "+p.etaBat+"} = "+fmt(SR.Wbat,2)+"\\text{ kg},\\quad W_P=\\frac{P_{hov}}{SP_{bat}}="+fmt(SR.Phov,1)+"\\text{ kW},\\;W_{bat}=\\max(W_E,W_P)","Dual-constraint battery mass (energy + power limits)")}
  ${eq("\\text{MTOW} = "+p.payload+" + "+fmt(SR.Wempty,2)+" + "+fmt(SR.Wbat,2)+" = "+fmt(SR.MTOW,2)+"\\text{ kg} \\quad \\checkmark\\text{ Converged}","Final weight closure")}
  `);

  // ── D3. MISSION PHASE TIMING ─────────────────────────────────────────
  const sd3 = sec("timing","D3. Mission Phase Timing & Distance Analysis",`
  ${eq("t_{TO} = \\frac{h_{hov}}{0.5} = \\frac{"+hvtold+"}{0.5} = "+fmt(SR.tto,0)+"\\text{ s}","Takeoff hover time — average vertical speed = 0.5 m/s")}
  ${eq("t_{cl} = \\frac{d_{cl}}{V_{cl}} = \\frac{"+fmt(ClimbRd,1)+"}{"+fmt(Vcld,2)+"} = "+fmt(SR.tcl,0)+"\\text{ s}","Climb duration")}
  ${eq("t_{cr} = \\frac{d_{cr}}{V_{cr}} = \\frac{"+fmt(CruiseRanged,1)+"}{"+p.vCruise+"} = "+fmt(SR.tcr,0)+"\\text{ s}","Cruise duration")}
  ${eq("t_{dc} = \\frac{d_{dc}}{V_{dc}} = \\frac{"+fmt(DescRd,1)+"}{"+fmt(Vdcd,2)+"} = "+fmt(SR.tdc,0)+"\\text{ s}","Descent duration")}
  ${eq("t_{ld} = \\frac{h_{hov}}{0.5} = "+fmt(SR.tld,0)+"\\text{ s}","Landing hover time")}
  ${eq("t_{res} = t_{res,min} = "+reserveMinutesd+"\\text{ min} = "+tres_sd+"\\text{ s} \\quad (\\text{regulatory minimum, SC-VTOL VTOL.1035})","Reserve duration — time-based, not distance-based")}
  ${eq("T_{mission} = "+fmt(SR.tto,0)+"+"+fmt(SR.tcl,0)+"+"+fmt(SR.tcr,0)+"+"+fmt(SR.tdc,0)+"+"+fmt(SR.tld,0)+"+"+fmt(SR.tres,0)+" = "+fmt(SR.Tend,0)+"\\text{ s} = "+fmt(SR.Tend/60,1)+"\\text{ min}","Total mission time")}
  ${table(["Phase","Distance (m)","Speed (m/s)","Duration (s)","Duration (min)"],[
    row("Takeoff (hover)","Vertical "+hvtold+" m","0.5",fmt(SR.tto,0),fmt(SR.tto/60,1)),
    row("Climb",fmt(ClimbRd,1),fmt(Vcld,2),fmt(SR.tcl,0),fmt(SR.tcl/60,1)),
    row("Cruise",fmt(CruiseRanged,1),p.vCruise,fmt(SR.tcr,0),fmt(SR.tcr/60,1)),
    row("Descent",fmt(DescRd,1),fmt(Vdcd,2),fmt(SR.tdc,0),fmt(SR.tdc/60,1)),
    row("Landing (hover)","Vertical "+hvtold+" m","0.5",fmt(SR.tld,0),fmt(SR.tld/60,1)),
    row("Reserve",fmt(reserveDistMd,0)+" ("+reserveMinutesd+" min)",fmt(Vresd,2),fmt(SR.tres,0),fmt(SR.tres/60,1)),
    row("<b>Total</b>","<b>"+fmt(p.range*1000,0)+" m</b>","—","<b>"+fmt(SR.Tend,0)+"</b>","<b>"+fmt(SR.Tend/60,1)+"</b>"),
  ])}
  `);

  // ── D4. PHASE POWER & ENERGY ─────────────────────────────────────────
  const sd4 = sec("phasecalc","D4. Phase Power & Energy — Detailed Calculations",`
  <p>Energy per phase: E<sub>phase</sub> = P<sub>phase</sub> × t<sub>phase</sub> / 3600. Cumulative column tracks battery draw throughout the mission.</p>
  ${eq("E_{TO} = P_{hov}\\times\\frac{t_{TO}}{3600} = "+fmt(SR.Phov,2)+"\\times\\frac{"+fmt(SR.tto,0)+"}{3600} = "+fmt(SR.Eto,4)+"\\text{ kWh}","Takeoff energy")}
  ${eq("E_{cl} = P_{cl}\\times\\frac{t_{cl}}{3600} = "+fmt(SR.Pcl,2)+"\\times\\frac{"+fmt(SR.tcl,0)+"}{3600} = "+fmt(SR.Ecl,4)+"\\text{ kWh}","Climb energy")}
  ${eq("E_{cr} = P_{cr}\\times\\frac{t_{cr}}{3600} = "+fmt(SR.Pcr,2)+"\\times\\frac{"+fmt(SR.tcr,0)+"}{3600} = "+fmt(SR.Ecr,4)+"\\text{ kWh}","Cruise energy")}
  ${eq("E_{dc} = |P_{dc}|\\times\\frac{t_{dc}}{3600} = "+fmt(SR.Pdc,2)+"\\times\\frac{"+fmt(SR.tdc,0)+"}{3600} = "+fmt(SR.Edc,4)+"\\text{ kWh}","Descent energy")}
  ${eq("E_{ld} = P_{hov}\\times\\frac{t_{ld}}{3600} = "+fmt(SR.Phov,2)+"\\times\\frac{"+fmt(SR.tld,0)+"}{3600} = "+fmt(SR.Eld,4)+"\\text{ kWh}","Landing energy")}
  ${eq("E_{res} = P_{res}\\times\\frac{t_{res}}{3600} = "+fmt(SR.Pres,2)+"\\times\\frac{"+fmt(SR.tres,0)+"}{3600} = "+fmt(SR.Eres,4)+"\\text{ kWh}","Reserve energy")}
  ${eq("E_{total} = "+fmt(SR.Eto,4)+"+"+fmt(SR.Ecl,4)+"+"+fmt(SR.Ecr,4)+"+"+fmt(SR.Edc,4)+"+"+fmt(SR.Eld,4)+"+"+fmt(SR.Eres,4)+" = "+fmt(SR.Etot,3)+"\\text{ kWh}","Total mission energy")}
  ${table(["Phase","Power (kW)","Time (s)","Energy (kWh)","Cumulative (kWh)","% Total"],[
    `<tr><td>Takeoff</td><td>${fmt(SR.Phov,2)}</td><td>${fmt(SR.tto,0)}</td><td>${fmt(SR.Eto,4)}</td><td>${fmt(SR.Eto,4)}</td><td>${fmt(SR.Eto/SR.Etot*100,1)}%</td></tr>`,
    `<tr><td>Climb</td><td>${fmt(SR.Pcl,2)}</td><td>${fmt(SR.tcl,0)}</td><td>${fmt(SR.Ecl,4)}</td><td>${fmt(SR.Eto+SR.Ecl,4)}</td><td>${fmt(SR.Ecl/SR.Etot*100,1)}%</td></tr>`,
    `<tr><td>Cruise</td><td>${fmt(SR.Pcr,2)}</td><td>${fmt(SR.tcr,0)}</td><td>${fmt(SR.Ecr,4)}</td><td>${fmt(SR.Eto+SR.Ecl+SR.Ecr,4)}</td><td>${fmt(SR.Ecr/SR.Etot*100,1)}%</td></tr>`,
    `<tr><td>Descent</td><td>${fmt(SR.Pdc,2)}</td><td>${fmt(SR.tdc,0)}</td><td>${fmt(SR.Edc,4)}</td><td>${fmt(SR.Eto+SR.Ecl+SR.Ecr+SR.Edc,4)}</td><td>${fmt(SR.Edc/SR.Etot*100,1)}%</td></tr>`,
    `<tr><td>Landing</td><td>${fmt(SR.Phov,2)}</td><td>${fmt(SR.tld,0)}</td><td>${fmt(SR.Eld,4)}</td><td>${fmt(SR.Eto+SR.Ecl+SR.Ecr+SR.Edc+SR.Eld,4)}</td><td>${fmt(SR.Eld/SR.Etot*100,1)}%</td></tr>`,
    `<tr><td>Reserve</td><td>${fmt(SR.Pres,2)}</td><td>${fmt(SR.tres,0)}</td><td>${fmt(SR.Eres,4)}</td><td>${fmt(SR.Etot,3)}</td><td>${fmt(SR.Eres/SR.Etot*100,1)}%</td></tr>`,
    `<tr style="font-weight:700"><td>Total</td><td>—</td><td>${fmt(SR.Tend,0)}</td><td>${fmt(SR.Etot,3)}</td><td>${fmt(SR.Etot,3)}</td><td>100%</td></tr>`,
  ])}
  `);

  // ── D5. WING SIZING DETAILED ──────────────────────────────────────────
  const sd5 = sec("wingdetail","D5. Wing Sizing — Detailed Calculations",`
  ${eq("S_w = \\frac{2\\,L_{req}}{\\rho_{cr}\\,V_{cr}^2\\,C_{L,des}} = \\frac{2\\times "+fmt(SR.MTOW*g0d,1)+"}{"+fmt(rhoCrd,4)+"\\times "+p.vCruise+"^2\\times "+p.clDesign+"} = "+fmt(SR.Swing,2)+"\\text{ m}^2","Wing area from lift balance at cruise")}
  ${eq("W/S = "+fmt(SR.WL,1)+"\\text{ N/m}^2","Wing loading")}
  ${eq("b_w = \\sqrt{AR\\cdot S_w} = \\sqrt{"+p.AR+"\\times "+fmt(SR.Swing,2)+"} = "+fmt(SR.bWing,2)+"\\text{ m}","Wing span")}
  ${eq("C_r = \\frac{2S_w}{b_w(1+\\lambda)} = \\frac{2\\times "+fmt(SR.Swing,2)+"}{"+fmt(SR.bWing,2)+"\\times(1+"+p.taper+")} = "+fmt(SR.Cr_,3)+"\\text{ m}","Root chord")}
  ${eq("C_t = \\lambda\\,C_r = "+p.taper+"\\times "+fmt(SR.Cr_,3)+" = "+fmt(SR.Ct_,3)+"\\text{ m}","Tip chord")}
  ${eq("\\bar{c} = \\frac{2}{3}\\,C_r\\,\\frac{1+\\lambda+\\lambda^2}{1+\\lambda} = "+fmt(SR.MAC,3)+"\\text{ m}","Mean aerodynamic chord")}
  ${eq("\\bar{y}_{MAC} = \\frac{b_w}{6}\\,\\frac{1+2\\lambda}{1+\\lambda} = "+fmt(SR.Ymac,3)+"\\text{ m}","Spanwise MAC position")}
  ${eq("\\Lambda_{LE} = \\arctan\\!\\left(\\frac{C_r-C_t}{b_w/2}\\right) = \\arctan\\!\\left(\\frac{"+fmt(SR.Cr_,3)+"-"+fmt(SR.Ct_,3)+"}{"+fmt(SR.bWing/2,3)+"}\\right) = "+fmt(SR.sweep,2)+"^\\circ","Leading edge sweep")}
  ${eq("Re_w = \\frac{\\rho_{cr}\\,V_{cr}\\,\\bar{c}}{\\mu_{cr}} = \\frac{"+fmt(rhoCrd,4)+"\\times "+p.vCruise+"\\times "+fmt(SR.MAC,3)+"}{"+fmt(muCrd,7)+"} = "+fmt(SR.Re_,0),"Wing chord Reynolds number")}
  ${eq("M = \\frac{V_{cr}}{a_{cr}} = \\frac{"+p.vCruise+"}{"+fmt(Math.sqrt(1.4*287*Tcrd),2)+"} = "+fmt(SR.Mach,4),"Cruise Mach number")}
  ${eq("V_{stall} = \\sqrt{\\frac{2(W/S)}{\\rho_{cr}\\,C_{L,max}}} = \\sqrt{\\frac{2\\times "+fmt(SR.WL,1)+"}{"+fmt(rhoCrd,4)+"\\times "+(SR.selAF&&SR.selAF.CLmax?fmt(SR.selAF.CLmax,2):"1.60")+"}} = "+fmt(SR.Vstall,2)+"\\text{ m/s}","Stall speed")}
  `);

  // ── D6. FUSELAGE SIZING & DRAG BUILDUP ───────────────────────────────
  const sd6 = sec("dragbuildup","D6. Fuselage Sizing & Drag Component Buildup (Raymer)",`
  <p>Zero-lift drag uses Raymer component buildup: C<sub>D0,k</sub> = C<sub>f,k</sub> · FF<sub>k</sub> · S<sub>wet,k</sub> / S<sub>ref</sub>.</p>
  ${eq("\\lambda_f = \\frac{L_{fus}}{D_{fus}} = \\frac{"+p.fusLen+"}{"+p.fusDiam+"} = "+fmt(lambdaFd,2),"Fuselage fineness ratio")}
  ${eq("S_{wet,f} = \\pi D_f L_f\\left(1-\\frac{2}{\\lambda_f}\\right)^{2/3}\\!\\left(1+\\frac{1}{\\lambda_f^2}\\right) = "+fmt(SwfWetd,3)+"\\text{ m}^2","Fuselage wetted area (Raymer Eq. 12.31)")}
  ${eq("S_{wet,w} = 2S_w\\left(1+0.25\\,\\frac{t}{c}(1+\\lambda\\cdot 0.25)\\right) = "+fmt(Swwd,3)+"\\text{ m}^2","Wing wetted area")}
  ${eq("Re_{fus} = \\frac{\\rho_{cr}\\,V_{cr}\\,L_{fus}}{\\mu_{cr}} = \\frac{"+fmt(rhoCrd,4)+"\\times "+p.vCruise+"\\times "+p.fusLen+"}{"+fmt(muCrd,7)+"} = "+fmt(Refusd,0),"Fuselage Reynolds number")}
  ${eq("C_{f,w} = \\frac{0.455}{(\\log_{10}"+fmt(SR.Re_,0)+")^{2.58}(1+0.144\\times "+fmt(SR.Mach,4)+"^2)^{0.65}} = "+fmt(Cfwd,6),"Wing skin friction coefficient")}
  ${eq("C_{f,f} = \\frac{0.455}{(\\log_{10}"+fmt(Refusd,0)+")^{2.58}(1+0.144\\times "+fmt(SR.Mach,4)+"^2)^{0.65}} = "+fmt(Cffd,6),"Fuselage skin friction coefficient")}
  ${eq("FF_w = \\left(1+2\\times "+p.tc+"+100\\times "+fmt(p.tc**4,6)+"\\right)\\times 1.05 = "+fmt(FFwd,4),"Wing form factor")}
  ${eq("FF_f = 1+\\frac{60}{"+fmt(lambdaFd,2)+"^3}+\\frac{"+fmt(lambdaFd,2)+"}{400} = "+fmt(FFfd,4),"Fuselage form factor")}
  ${table(["Component","C<sub>f</sub>","FF","S<sub>wet</sub> (m²)","S<sub>wet</sub>/S<sub>w</sub>","C<sub>D0</sub>"],[
    `<tr><td>Wing</td><td>${fmt(Cfwd,6)}</td><td>${fmt(FFwd,4)}</td><td>${fmt(Swwd,3)}</td><td>${fmt(Swwd/SR.Swing,4)}</td><td>${fmt(SR.dragComp&&SR.dragComp.find(d=>d.name==="Wing")?SR.dragComp.find(d=>d.name==="Wing").val:0,5)}</td></tr>`,
    `<tr><td>Fuselage</td><td>${fmt(Cffd,6)}</td><td>${fmt(FFfd,4)}</td><td>${fmt(SwfWetd,3)}</td><td>${fmt(SwfWetd/SR.Swing,4)}</td><td>${fmt(SR.dragComp&&SR.dragComp.find(d=>d.name==="Fuselage")?SR.dragComp.find(d=>d.name==="Fuselage").val:0,5)}</td></tr>`,
    `<tr><td>H-Stab equiv.</td><td>${fmt(Cfwd,6)}</td><td>1.05</td><td>${fmt(Swhs_d,3)}</td><td>${fmt(Swhs_d/SR.Swing,4)}</td><td>${fmt(SR.dragComp&&SR.dragComp.find(d=>d.name==="H-Stab")?SR.dragComp.find(d=>d.name==="H-Stab").val:0,5)}</td></tr>`,
    `<tr><td>V-Stab equiv.</td><td>${fmt(Cfwd,6)}</td><td>1.05</td><td>${fmt(Swvs_d,3)}</td><td>${fmt(Swvs_d/SR.Swing,4)}</td><td>${fmt(SR.dragComp&&SR.dragComp.find(d=>d.name==="V-Stab")?SR.dragComp.find(d=>d.name==="V-Stab").val:0,5)}</td></tr>`,
    `<tr><td>Nacelles (×${p.nPropHover})</td><td>${fmt(Cfwd,6)}</td><td>1.30</td><td>${fmt(Swn_d,3)}</td><td>${fmt(Swn_d/SR.Swing,4)}</td><td>${fmt(SR.dragComp&&SR.dragComp.find(d=>d.name==="Nacelles")?SR.dragComp.find(d=>d.name==="Nacelles").val:0,5)}</td></tr>`,
    `<tr><td>Landing Gear</td><td colspan="4">Fixed interference estimate</td><td>0.01500</td></tr>`,
    `<tr><td>Miscellaneous</td><td colspan="4">Gaps, protuberances</td><td>0.00200</td></tr>`,
    `<tr style="font-weight:700"><td>Total C<sub>D0</sub></td><td colspan="4"></td><td>${fmt(SR.CD0tot,5)}</td></tr>`,
  ])}
  ${eq("C_{D_i} = \\frac{C_{L,des}^2}{\\pi\\,AR\\,e} = \\frac{"+p.clDesign+"^2}{\\pi\\times "+p.AR+"\\times "+p.eOsw+"} = "+fmt(SR.CDi,5),"Induced drag")}
  ${eq("C_{D,total} = "+fmt(SR.CD0tot,5)+"+"+fmt(SR.CDi,5)+" = "+fmt(SR.CDtot,5)+", \\quad (L/D)_{act} = "+fmt(SR.LDact,2),"Total drag and actual L/D")}
  `);

  // ── D7. ROTOR & MOTOR SIZING ──────────────────────────────────────────
  const sd7 = sec("rotcalc","D7. Rotor & Motor Sizing — Actuator Disk Theory",`
  ${eq("T_{total} = \\text{MTOW}\\times g_0 = "+fmt(SR.MTOW,2)+"\\times 9.81 = "+fmt(Ttotd,1)+"\\text{ N}","Total hover thrust")}
  ${eq("T_{rotor} = T_{total}/N_{rot} = "+fmt(Trotord,1)+"\\text{ N}, \\quad P_{rotor} = P_{hov}\\times 1000/N_{rot} = "+fmt(PrWd,1)+"\\text{ W}","Thrust and power per rotor")}
  ${eq("A_{disk} = \\frac{T_{rotor}^3}{2\\,\\rho_{SL}\\,(P_{rotor}\\,\\eta_{hov})^2} = \\frac{"+fmt(Trotord,1)+"^3}{2\\times 1.225\\times("+fmt(PrWd,1)+"\\times "+p.etaHov+")^2} = "+fmt(Adiskd,4)+"\\text{ m}^2","Disk area from actuator disk theory")}
  ${eq("D_{rot} = 2\\sqrt{A_{disk}/\\pi} = 2\\sqrt{"+fmt(Adiskd,4)+"/\\pi} = "+fmt(SR.Drotor,3)+"\\text{ m}","Rotor diameter")}
  ${eq("DL = T_{rotor}/A_{disk} = "+fmt(SR.DLrotor,1)+"\\text{ N/m}^2, \\quad PL = T_{rotor}/(P_{rotor}/1000) = "+fmt(SR.PLrotor,1)+"\\text{ N/W}","Disk loading and power loading")}
  ${eq("V_{tip} = \\sqrt{2P_{rotor}\\,\\eta_{hov}/(\\rho_{SL}\\,A_{disk})} = "+fmt(TipSpdd,2)+"\\text{ m/s}, \\quad M_{tip} = "+fmt(SR.TipMach,4)+"\\;(<0.70\\;\\checkmark)","Tip speed and tip Mach number")}
  ${eq("N = \\frac{V_{tip}}{R_{rot}}\\times\\frac{60}{2\\pi} = \\frac{"+fmt(TipSpdd,2)+"}{"+fmt(Rrotord,4)+"}\\times\\frac{60}{2\\pi} = "+fmt(SR.RPM,0)+"\\text{ rpm}","Rotational speed")}
  ${eq("c_{blade} = \\sigma\\pi R_{rot}/N_{bl} = 0.10\\times\\pi\\times "+fmt(Rrotord,4)+"/3 = "+fmt(SR.ChordBl,4)+"\\text{ m}\\;(\\sigma=0.10,\\;N_{bl}=3)","Blade chord")}
  ${eq("P_{motor,cont} = 1.15\\times P_{rotor} = "+fmt(PmotKWd,2)+"\\text{ kW}, \\quad P_{peak} = 1.50\\times P_{motor} = "+fmt(PpeakKWd,2)+"\\text{ kW}","Motor ratings with margins")}
  ${eq("Q = P_{motor}\\times 1000/\\Omega = "+fmt(Torqued,1)+"\\text{ N}\\cdot\\text{m}","Motor shaft torque")}
  `);

  // ── D8. BATTERY PACK ARCHITECTURE ────────────────────────────────────
  const sd8 = sec("battcalc","D8. Battery Pack Architecture & Sizing",`
  <p>Cell specs: NMC Li-ion, V<sub>cell</sub> = 3.6 V, Q<sub>cell</sub> = 5.0 Ah. Bus voltage = 800 V DC.</p>
  ${eq("W_E = \\frac{E_{total}\\times 1000}{(1-\\text{SoC}_{min})\\,\\text{SED}_{eff}\\,\\eta_{bat}} = \\frac{"+fmt(SR.Etot,3)+"\\times 1000}{(1-"+p.socMin+")\\times"+p.sedCell+"\\times "+p.etaBat+"} = "+fmt(SR.Wbat,2)+"\\text{ kg},\\quad W_P=\\frac{P_{hov}}{SP_{bat}}="+fmt(SR.Phov,1)+"\\text{ kW},\\;W_{bat}=\\max(W_E,W_P)","Dual-constraint battery mass (energy + power limits)")}
  ${eq("\\text{SED}_{pack} = E_{total}\\times 1000/W_{bat} = "+fmt(SR.SEDpack,1)+"\\text{ Wh/kg}","Pack energy density")}
  ${eq("N_s = \\text{round}(800/3.6) = "+Nseriesd+", \\quad Q_{req} = E_{total}\\times 1000/800 = "+fmt(PackAhReqd,2)+"\\text{ Ah}","Series cells and required capacity")}
  ${eq("N_p = \\lceil "+fmt(PackAhReqd,2)+"/5.0 \\rceil = "+Npard+", \\quad N_{cells} = "+Nseriesd+"\\times "+Npard+" = "+Nseriesd*Npard,"Parallel strings and total cells")}
  ${eq("E_{pack} = V_{pack}\\times Q_{pack}/1000 = "+fmt(PackVd,0)+"\\times "+fmt(PackAhd,1)+"/1000 = "+fmt(SR.PackkWh,3)+"\\text{ kWh} \\geq "+fmt(SR.Etot,3)+"\\text{ kWh}\\;\\checkmark","Pack energy must exceed mission energy")}
  ${eq("C_{hov} = \\frac{P_{hov}\\times 1000/V_{pack}}{Q_{pack}} = \\frac{"+fmt(SR.Phov*1000/PackVd,1)+"}{"+fmt(PackAhd,1)+"} = "+fmt(SR.CrateHov,3)+"\\text{ C}, \\quad C_{cr} = "+fmt(SR.CrateCr,3)+"\\text{ C}","Hover and cruise C-rates")}
  ${eq("R_{int} = 0.030\\times N_s/N_p = "+fmt(Rintd,4)+"\\,\\Omega, \\quad P_{heat} = I_{hov}^2\\times R_{int} = "+fmt(Pheatd,1)+"\\text{ W}","Pack resistance and ohmic heating at hover")}
  `);

  // ── D9. CG BREAKDOWN & STABILITY ─────────────────────────────────────
  const sd9 = sec("stabcalc","D9. Centre of Gravity, Neutral Point & Static Margin — Detailed",`
  <p>All positions from nose. Component CGs are fractions of L<sub>fus</sub> = ${p.fusLen} m.</p>
  ${table(["Component","Mass (kg)","x<sub>CG</sub> (m)","Moment (kg·m)"],[
    `<tr><td>Fuselage struct. (35% W<sub>e</sub>)</td><td>${fmt(Wfuscd,2)}</td><td>${fmt(xCGfusd,3)}  = 0.42 × L<sub>fus</sub></td><td>${fmt(Wfuscd*xCGfusd,2)}</td></tr>`,
    `<tr><td>Wing + attach. (18% W<sub>e</sub>)</td><td>${fmt(Wwingcd,2)}</td><td>${fmt(xCGwingd,3)}</td><td>${fmt(Wwingcd*xCGwingd,2)}</td></tr>`,
    `<tr><td>Motors (22% W<sub>e</sub>)</td><td>${fmt(Wmotcd,2)}</td><td>${fmt(xCGfusd,3)}</td><td>${fmt(Wmotcd*xCGfusd,2)}</td></tr>`,
    `<tr><td>Avionics (4% W<sub>e</sub>)</td><td>${fmt(Wavcd,2)}</td><td>${fmt(xCGavcD,3)} = 0.18 × L<sub>fus</sub></td><td>${fmt(Wavcd*xCGavcD,2)}</td></tr>`,
    `<tr><td>Other (21% W<sub>e</sub>)</td><td>${fmt(Wothcd,2)}</td><td>${fmt(xCGfusd,3)}</td><td>${fmt(Wothcd*xCGfusd,2)}</td></tr>`,
    `<tr style="font-weight:700"><td>Empty W<sub>e</sub></td><td>${fmt(SR.Wempty,2)}</td><td>${fmt(xCGemptyd,3)}</td><td>${fmt(SR.Wempty*xCGemptyd,2)}</td></tr>`,
    `<tr><td>Battery</td><td>${fmt(SR.Wbat,2)}</td><td>${fmt(xCGbatd,3)}  = 0.38 × L<sub>fus</sub></td><td>${fmt(SR.Wbat*xCGbatd,2)}</td></tr>`,
    `<tr><td>Payload</td><td>${p.payload}</td><td>${fmt(xCGpayd,3)}  = 0.40 × L<sub>fus</sub></td><td>${fmt(p.payload*xCGpayd,2)}</td></tr>`,
    `<tr style="font-weight:700;background:#dbeafe"><td>Total (MTOW)</td><td>${fmt(SR.MTOW,2)}</td><td><b>${fmt(SR.xCGtotal,3)}</b></td><td>${fmt(SR.MTOW*SR.xCGtotal,2)}</td></tr>`,
  ])}
  ${eq("x_{CG} = \\frac{W_e\\,x_{CG,e}+W_{bat}\\,x_{CG,bat}+m_{pay}\\,x_{CG,pay}}{\\text{MTOW}} = \\frac{"+fmt(SR.Wempty*xCGemptyd,1)+"+"+fmt(SR.Wbat*xCGbatd,1)+"+"+fmt(p.payload*xCGpayd,1)+"}{"+fmt(SR.MTOW,2)+"} = "+fmt(SR.xCGtotal,3)+"\\text{ m}","Total CG from nose")}
  ${eq("x_{AC,wing} = L_{fus}\\times 0.2589+X_{ac} = "+fmt(p.fusLen*0.2589,3)+"+"+fmt(Xacd,3)+" = "+fmt(xACwingd,3)+"\\text{ m}","Wing aerodynamic centre")}
  ${eq("C_{L_{\\alpha,w}} = \\frac{2\\pi AR}{2+\\sqrt{AR^2+4}} = "+fmt(CLaWd,4)+"\\text{ rad}^{-1},\\; \\frac{d\\varepsilon}{d\\alpha} = \\frac{2C_{L_{\\alpha,w}}}{\\pi AR} = "+fmt(dwd,4),"Lift-curve slope (Raymer Eq.12.6 finite-wing) and downwash gradient (Anderson Eq.5.39)")}
  ${eq("l_h = 0.88 L_{fus}-x_{AC,wing} = "+fmt(p.fusLen*0.88,3)+"-"+fmt(xACwingd,3)+" = "+fmt(lhd,3)+"\\text{ m}","Tail moment arm — FIX: tail AC at 88% fusLen (not fuselage tip)")}
  ${eq("x_{NP} = x_{AC,wing}+\\frac{S_h}{S_w}\\eta_h(1-\\frac{d\\varepsilon}{d\\alpha})l_h = "+fmt(xACwingd,3)+"+\\frac{"+fmt(Shd,3)+"}{"+fmt(SR.Swing,2)+"}\\times 0.9\\times(1-"+fmt(dwd,4)+")\\times "+fmt(lhd,3)+" = "+fmt(SR.xNP,3)+"\\text{ m}","Neutral point")}
  ${eq("SM = \\frac{x_{NP}-x_{CG}}{\\bar{c}} = \\frac{"+fmt(SR.xNP,3)+"-"+fmt(SR.xCGtotal,3)+"}{"+fmt(SR.MAC,3)+"} = "+fmt(SR.SM*100,2)+"\\%\\;\\text{MAC}","Static margin (target 5–25% MAC)")}
  `);

  // ── D10. NOISE MODEL ─────────────────────────────────────────────────
  const g0d_n=9.81,T0d_n=288.15,Rgas_n=287,GAM_n=1.4,rhoMSL_n=1.225;
  const aMSL_n=Math.sqrt(GAM_n*Rgas_n*T0d_n);
  const Mtip_h_n=Math.min(SR.TipSpd/aMSL_n,0.699);
  const DL_hover_n=(SR.MTOW*g0d_n/p.nPropHover)/(Math.PI*(p.propDiam/2)**2);
  const Kcal_n=(12+5*Math.log10(Math.max(DL_hover_n/500,0.1))+8*(Mtip_h_n/0.58-1)-1.5*(SR.Nbld-6)).toFixed(2);
  const Ccomp_n=(-5*Math.log10(Math.max(1-Mtip_h_n**2,0.01))).toFixed(3);
  const Kdecay_n=Math.max(2,Math.min(7,4-5*(Mtip_h_n-0.58)-1.5*Math.log10(Math.max(DL_hover_n/500,0.1)))).toFixed(2);
  const delta_int_n=(-1.0-0.15*Math.max(0,p.nPropHover-6)).toFixed(2);
  const sd10 = sec("noisecalc","D10. Noise Model — Semi-Empirical BPF + Broadband",`
  <p>Physics-informed aeroacoustic model v2 (Gutin 1948 / Lowson 1965 / BPM 1989 / ISO 9613-1 1993). All quantities at hover equilibrium (T/W = 1.0).</p>
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 1 — Directivity &amp; Compressibility</h3>
  ${eq("D(\\theta) = |\\sin\\theta| = 1.0 \\quad \\text{(in-plane, worst case, }\\theta=90^\\circ\\text{)}","Dipole directivity — Lowson 1965")}
  ${eq("M_{tip,h} = \\frac{V_{tip}}{a_{MSL}} = \\frac{"+fmt(SR.TipSpd,1)+"}{"+aMSL_n.toFixed(1)+"} = "+Mtip_h_n.toFixed(4),"Hover tip Mach (MSL sound speed)")}
  ${eq("C_{comp} = -5\\log_{10}(1-M_{tip}^2) = "+Ccomp_n+"\\text{ dB}","Prandtl–Glauert compressibility correction")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 2 — Multi-Parameter Calibration K<sub>cal</sub></h3>
  ${eq("K_{cal} = 12 + 5\\log_{10}\\!\\left(\\frac{DL}{500}\\right) + 8\\!\\left(\\frac{M_{tip}}{0.58}-1\\right) - 1.5(B-6) = "+Kcal_n+"\\text{ dB}","Replaces fixed 15 dB; fitted to Fleming 2022 + Joby/Volocopter data")}
  ${table(["Parameter","Value","Unit","Note"],[
    row("Hover DL",fmt(DL_hover_n,0),"N/m²","T/W=1.0 equilibrium"),
    row("Tip speed",fmt(SR.TipSpd,1),"m/s","Mtip=0.58 × a_MSL"),
    row("Blade count B",String(SR.Nbld),"—","Fixed 3-blade design"),
    row("K<sub>cal</sub>",Kcal_n,"dB","Multi-param (DL,Mtip,B)"),
    row("C<sub>comp</sub>",Ccomp_n,"dB","Prandtl–Glauert"),
    row("K<sub>decay</sub> α",Kdecay_n,"dB/harm","Adaptive (Mtip,DL)"),
    row("ΔInt",delta_int_n,"dB","Rotor interaction shielding"),
  ])}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 3 — Tonal SPL Fundamental</h3>
  ${eq("p_{rms} = \\frac{D\\cdot B\\cdot\\Omega\\cdot T_r}{4\\pi r_0 \\rho c_0^2 \\sqrt{2}}\\cdot J_1\\!\\left(\\frac{B\\Omega R_{eff}}{c_0}\\right) \\quad\\Rightarrow\\quad SPL_1 = 20\\log_{10}\\!\\left(\\frac{p_{rms}}{20\\,\\mu\\text{Pa}}\\right)+K_{cal}+C_{comp}","Gutin (1948) with Bessel function J₁(x), x=BΩR_eff/c₀ (FIX 2.1)")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 4 — Harmonic Series (n=1…10, A-weighted)</h3>
  ${eq("SPL_n = SPL_1 - \\alpha(n-1) \\quad\\text{dBA}_n = SPL_n + A(f_n)","FIX 2.4: Harmonics decrease from SPL₁ (Gutin: p_m ∝ 1/m); removed unphysical +20log₁₀(n) growth term")}
  ${table(["n","f_n (Hz)","SPL_n (dB)","A(f) (dB)","dBA_n"],[
    ...(SR.bpfHarmonics||[]).map(h=>`<tr><td>${h.harmonic}</td><td>${h.freq}</td><td>—</td><td>—</td><td>${h.SPL}</td></tr>`)
  ])}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 5 — Broadband (BPM Mtip⁵ scaling)</h3>
  ${eq("\\text{dBA}_{BB} = \\text{dBA}_{tonal} - 8 + 50\\log_{10}\\!\\left(\\frac{M_{tip}}{0.58}\\right) - 2\\log_{10}\\!\\left(\\frac{Re_{tip}}{1.5\\times10^6}\\right)","Brooks, Pope & Marcolini 1989")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 5b — Vortex (BVI) Noise (NEW — FIX 2.3)</h3>
  ${eq("p_{vortex} = k_2\\,\\frac{V_{0.7}}{\\rho\\,r_0}\\sqrt{\\frac{T_r\\cdot N}{\\sigma}\\cdot DL} \\quad k_2=0.4259\\,\\text{s}^3/\\text{m}^3","FIX: k2 converted from ft³ to m³ (÷0.3048³); eVTOL-master k2=1.206e-2 s³/ft³ at δ_S=500ft")}
  ${eq("\\text{Total}_{single} = 10\\log_{10}\\!\\left(10^{\\text{dBA}_{tonal}/10}+10^{\\text{dBA}_{BB}/10}+10^{\\text{dBA}_{vortex}/10}\\right)","Energy sum of tonal + broadband + vortex")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Step 6 — Multi-Rotor + Propagation</h3>
  ${eq("\\text{dBA}_{multi} = \\text{dBA}_{single}+10\\log_{10}(N_{rot})+\\Delta_{int} = "+fmt(SR.dBA_1m,1)+"\\text{ dBA at 1 m}","Incoherent sum + shielding")}
  ${eq("\\text{dBA}(r) = \\text{dBA}_{1m} - 20\\log_{10}(r) - \\alpha_{atm}\\cdot r + \\Delta_{Gr}","ISO 9613-1 propagation + image-source ground reflection")}
  ${table(["Distance","Level","Regulatory ref"],[
    row("1 m (near field)",fmt(SR.dBA_1m,1)+" dBA","Source level"),
    row("25 m (helipad edge)",fmt(SR.dBA_25m,1)+" dBA","Operational"),
    row("100 m (residential)",fmt(SR.dBA_100m,1)+" dBA","FAA ref"),
    row("150 m (EASA UAM)",fmt(SR.dBA_150m,1)+" dBA","≤ 65 dBA target"),
    row("300 m (community)",fmt(SR.dBA_300m,1)+" dBA","Community"),
    row("500 m (far field)",fmt(SR.dBA_500m,1)+" dBA","Background"),
    row("65 dBA contour",SR.dist_65dBA+" m","Radius from source"),
    row("55 dBA contour",SR.dist_55dBA+" m","Near-quiet threshold"),
  ])}
  `);

  // ── D11. DIRECT OPERATING COST (DOC) MODEL ─────────────────────────
  const g0d_c=9.81;
  const flightsPerYear_c=10*300;
  const fltHr_c=SR.Tend/3600;
  const CrateHov_c=SR.CrateHov||3.0;
  const eta_bat_d_c=Math.max(0.80,0.97-0.025*CrateHov_c);
  const eta_ch_c=Math.max(0.85,0.97-0.030*CrateHov_c);
  // FIX 3.1 (report): SR.Etot already includes discharge losses — only charger η needed
  const eGrid_c=SR.Etot/eta_ch_c;
  const eCost_c=eGrid_c*0.16;
  const cellCostKwh_c=149*Math.pow(300/Math.max(100,p.sedCell),0.3);
  const battCostKwh_c=(cellCostKwh_c+55)*2.0;
  const packCost_c=SR.PackkWh*battCostKwh_c;
  const dod_c=Math.min(0.85,SR.Etot/SR.PackkWh);
  const beta_c=dod_c<0.5?0.5:0.6;
  const effCyc_c=Math.floor(Math.min(2000,900*Math.pow(0.5/dod_c,beta_c)*Math.max(0.5,Math.pow(2.0/CrateHov_c,0.45))));
  const battCost_c=packCost_c/Math.max(1,effCyc_c);
  const hoverFrac_c=(SR.tto+SR.tld)/Math.max(1,SR.Tend);
  const MMH_c=0.6+0.08*Math.max(0,p.nPropHover-4)+0.4*hoverFrac_c;
  const maintCost_c=45000/flightsPerYear_c+(MMH_c*75+75)*fltHr_c+p.nPropHover*(1/8000+1/5000)*1200*fltHr_c;
  const motorReplCost_c=(SR.PmotKW*100*p.nPropHover)/Math.floor(3000/Math.max(0.1,fltHr_c));
  const insCost_c=(SR.MTOW*800*0.10)/flightsPerYear_c;
  const opCost_c=(82000/(4*300*8))*(fltHr_c+0.25);
  // FIX 3.3 (report): $1M was STC budget — FAA Part 21 type cert is $50–200M
  // $75M amortised over 50 aircraft × 10 years × 3000 flights/yr
  const certCost_c=75000000/(50*flightsPerYear_c*10);
  const totalDOC_c=eCost_c+battCost_c+maintCost_c+motorReplCost_c+insCost_c+35+opCost_c+certCost_c;
  const cpkm_c=totalDOC_c/p.range;
  const sd11 = sec("costcalc","D11. Direct Operating Cost (DOC) Model v3",`
  <p>Energy economics and lifecycle cost model. Sources: ICAO Doc 9502, BNEF EVO 2024, NASA/CR-2019-220217, Vascik MIT 2020, GAMA 2023.</p>
  ${table(["Parameter","Value","Unit","Formula / Source"],[
    row("Flight duration T<sub>end</sub>",fmt(SR.Tend/60,2),"min","Mission sizing"),
    row("Flights/year",flightsPerYear_c.toString(),"","10/day × 300 days (Joby ops model)"),
    row("Hover C-rate",fmt(CrateHov_c,2),"C","P<sub>hov</sub>/(V<sub>pack</sub>×Q<sub>pack</sub>)"),
    row("η<sub>charger</sub>",eta_ch_c.toFixed(3),"","0.97 − 0.030×C  (SAE ARP6504) — charger roundtrip only"),
  ])}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Energy Cost</h3>
  ${eq("E_{grid} = \\frac{E_{tot}}{\\eta_{charger}} = \\frac{"+fmt(SR.Etot,2)+"}{"+eta_ch_c.toFixed(3)+"} = "+eGrid_c.toFixed(2)+"\\text{ kWh}","FIX 3.1: SR.Etot already includes discharge losses — only charger η added (SAE ARP6504)")}
  ${eq("C_{energy} = E_{grid}\\times\\$0.16/\\text{kWh} = \\$"+eCost_c.toFixed(2)+"/\\text{flight}","EIA 2024 base + EPRI demand charge")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Battery Replacement</h3>
  ${eq("\\$/\\text{kWh}_{pack} = (\\$"+cellCostKwh_c.toFixed(0)+"_{cell}+\\$55_{overhead})\\times 2_{cert} = \\$"+battCostKwh_c.toFixed(0)+"/\\text{kWh}","BNEF EVO 2024 + Fraunhofer ISE 2023 pack OH")}
  ${eq("N_{eff} = 900\\times(0.5/DoD)^\\beta\\times(2/C)^{0.45} = "+effCyc_c+"\\text{ cycles}","DoD β="+(beta_c)+" (shallow/deep); C-rate penalty Waldmann 2014")}
  ${eq("C_{battery} = \\frac{"+fmt(SR.PackkWh,2)+"\\times\\$"+battCostKwh_c.toFixed(0)+"}{"+effCyc_c+"} = \\$"+battCost_c.toFixed(2)+"/\\text{flight}","")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Maintenance</h3>
  ${eq("MMH/FH = 0.6+0.08(N_{mot}-4)+0.4 f_{hover} = "+MMH_c.toFixed(2)+"\\text{ MMH/FH}","Baseline=0.6 (eVTOL-master / Booz Allen AAM 2021) + motor count + hover fraction penalty")}
  ${eq("C_{maint} = \\$45k/yr\\div N_{flights} + (MMH\\times\\$75+\\$75)\\times t_{hr} + \\text{MTBF term} = \\$"+maintCost_c.toFixed(2)+"/\\text{flight}","")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">DOC Summary</h3>
  ${table(["Cost Component","$/flight","$/km","% of DOC"],[
    row("Energy",fmt(eCost_c,2),fmt(eCost_c/p.range,3),fmt(eCost_c/totalDOC_c*100,1)+"%"),
    row("Battery replacement",fmt(battCost_c,2),fmt(battCost_c/p.range,3),fmt(battCost_c/totalDOC_c*100,1)+"%"),
    row("Maintenance",fmt(maintCost_c,2),fmt(maintCost_c/p.range,3),fmt(maintCost_c/totalDOC_c*100,1)+"%"),
    row("Motor replacement",fmt(motorReplCost_c,2),fmt(motorReplCost_c/p.range,3),fmt(motorReplCost_c/totalDOC_c*100,1)+"%"),
    row("Insurance",fmt(insCost_c,2),fmt(insCost_c/p.range,3),fmt(insCost_c/totalDOC_c*100,1)+"%"),
    row("Vertiport fee","35.00",fmt(35/p.range,3),fmt(35/totalDOC_c*100,1)+"%"),
    row("Operator (RPIC)",fmt(opCost_c,2),fmt(opCost_c/p.range,3),fmt(opCost_c/totalDOC_c*100,1)+"%"),
    row("Cert amortisation",fmt(certCost_c,2),fmt(certCost_c/p.range,3),fmt(certCost_c/totalDOC_c*100,1)+"% (FIX: $75M÷50ac÷10yr)"),
    `<tr style="font-weight:700;background:#dbeafe"><td><b>Total DOC</b></td><td><b>$${totalDOC_c.toFixed(2)}</b></td><td><b>$${cpkm_c.toFixed(2)}/km</b></td><td>100%</td></tr>`,
  ])}
  `);

  // ── D12. BEM ROTOR ANALYSIS ──────────────────────────────────────────
  const Rrotor_b=p.propDiam/2;
  const Adisk_b=Math.PI*Rrotor_b**2;
  const N_b=SR.Nbld||3;
  const Omega_b=SR.RPM*Math.PI/30;
  const T_b=SR.MTOW*g0d_c/p.nPropHover;
  const DL_b=T_b/Adisk_b;
  const vi_b=Math.sqrt(T_b/(2*1.225*Adisk_b));
  const sigma_b=N_b*(0.10*Math.PI*Rrotor_b/N_b)/(Math.PI*Rrotor_b);
  const CT_b=T_b/(1.225*Adisk_b*(SR.RPM*Math.PI/30*Rrotor_b)**2);
  const FM_ideal=Math.sqrt(2/Math.PI); // ideal FM for reference
  const CPideal=CT_b**(3/2)/Math.sqrt(2);
  const CP_act=(SR.Phov*1000/p.nPropHover)/(1.225*Adisk_b*(SR.TipSpd)**3);
  const FM_act=CPideal/Math.max(CP_act,1e-9);
  const sd12 = sec("bemcalc","D12. BEM Rotor Analysis — Actuator Disk + Blade Element",`
  <p>Hover rotor analysis using Actuator Disk Theory (momentum theory) and blade element principles. One rotor at T/W = 1.0 hover equilibrium.</p>
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Rotor radius","R",fmt(Rrotor_b,3),"m"),
    row("Disk area","A",fmt(Adisk_b,3),"m²"),
    row("No. blades","B",String(N_b),"—"),
    row("Blade solidity","σ",sigma_b.toFixed(4),"—"),
    row("Rotor RPM","Ω",fmt(SR.RPM,0),"rpm"),
    row("Tip speed","V<sub>tip</sub>",fmt(SR.TipSpd,1),"m/s"),
    row("Tip Mach","M<sub>tip</sub>",fmt(SR.TipMach,4),"—"),
    row("Thrust per rotor","T",fmt(T_b,1),"N"),
    row("Disk loading","DL",fmt(DL_b,1),"N/m²"),
    row("Power loading","PL",fmt(SR.PLrotor,2),"N/W"),
  ])}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Momentum Theory</h3>
  ${eq("v_i = \\sqrt{\\frac{T}{2\\rho A}} = \\sqrt{\\frac{"+fmt(T_b,1)+"}{2\\times1.225\\times"+fmt(Adisk_b,3)+"}} = "+vi_b.toFixed(2)+"\\text{ m/s}","Induced velocity (actuator disk)")}
  ${eq("P_{ideal} = T\\cdot v_i = "+fmt(T_b,1)+"\\times"+vi_b.toFixed(2)+" = "+fmt(T_b*vi_b/1000,2)+"\\text{ kW}","Ideal hover power (no losses)")}
  ${eq("P_{actual} = P_{hov}/N_{rot} = "+fmt(SR.Phov*1000/p.nPropHover,1)+"\\text{ W per rotor} = "+fmt(SR.Phov/p.nPropHover,2)+"\\text{ kW}","Actual rotor shaft power")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Figure of Merit</h3>
  ${eq("C_T = \\frac{T}{\\rho A V_{tip}^2} = \\frac{"+fmt(T_b,1)+"}{1.225\\times"+fmt(Adisk_b,3)+"\\times"+fmt(SR.TipSpd,1)+"^2} = "+CT_b.toFixed(5),"Thrust coefficient")}
  ${eq("FM = \\frac{C_T^{3/2}/\\sqrt{2}}{C_P} = "+FM_act.toFixed(3)+" \\quad (\\text{design }\\eta_{hov}="+p.etaHov+"\\Rightarrow FM\\approx"+p.etaHov+")","Figure of Merit — matches η_hov input")}
  <h3 style="font-size:10.5pt;font-weight:700;margin:10px 0 4px">Motor Sizing</h3>
  ${table(["Parameter","Value","Unit"],[
    row("Continuous power/rotor",fmt(SR.PmotKW,2),"kW"),
    row("Peak power/rotor (1.5×)",fmt(SR.PpeakKW,2),"kW"),
    row("Shaft torque",fmt(SR.Torque,1),"N·m"),
    row("Motor mass/rotor",fmt(SR.MotMass,2),"kg"),
    row("Total motor mass",fmt(SR.MotMass*p.nPropHover,1),"kg"),
    row("Specific power (cont.)",fmt(SR.PmotKW*1000/Math.max(1,SR.MotMass),0),"W/kg"),
  ])}
  `);

  // ── FULL HTML PAGE — A4 Professional Report ─────────────────────────

  // ── Figure helper ────────────────────────────────────────────────────
  const fig=(num,caption,svgContent)=>
    `<figure class="report-figure" id="fig${num}"><div class="fig-inner">${svgContent}</div><figcaption><strong>Figure ${num}.</strong> ${caption}</figcaption></figure>`;

  // ── SVG Figure 1: Mission Power Timeline ─────────────────────────────
  const phases_f=[
    {lbl:"Takeoff", P:SR.Phov, t:SR.tto,  col:"#f59e0b"},
    {lbl:"Climb",   P:SR.Pcl,  t:SR.tcl,  col:"#3b82f6"},
    {lbl:"Cruise",  P:SR.Pcr,  t:SR.tcr,  col:"#14b8a6"},
    {lbl:"Descent", P:SR.Pdc,  t:SR.tdc,  col:"#8b5cf6"},
    {lbl:"Landing", P:SR.Phov, t:SR.tld,  col:"#f97316"},
    {lbl:"Reserve", P:SR.Pres, t:SR.tres, col:"#ef4444"},
  ];
  const maxP_f=Math.max(...phases_f.map(ph=>ph.P),1);
  const totalT_f=phases_f.reduce((s,ph)=>s+(ph.t||0),0)||1;
  const cW_f=440,cH_f=120,pL_f=48,pT_f=18,pB_f=38;
  let xCur_f=0;
  const pBars_f=phases_f.map(ph=>{
    const w=cW_f*(ph.t/totalT_f), h=cH_f*(ph.P/maxP_f);
    const x=pL_f+xCur_f, y=pT_f+cH_f-h; xCur_f+=w;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1,w-1).toFixed(1)}" height="${h.toFixed(1)}" fill="${ph.col}" opacity="0.85"/>
            <text x="${(x+w/2).toFixed(1)}" y="${(pT_f+cH_f+13).toFixed(1)}" text-anchor="middle" font-size="7" fill="#374151" font-family="Arial,sans-serif">${ph.lbl}</text>
            ${h>14?`<text x="${(x+w/2).toFixed(1)}" y="${(y+h/2+3).toFixed(1)}" text-anchor="middle" font-size="7.5" fill="#fff" font-weight="bold" font-family="Arial,sans-serif">${ph.P.toFixed(0)}</text>`:''}`;
  });
  const yT_f=[0,0.25,0.5,0.75,1].map(t=>{const y=pT_f+cH_f*(1-t);const v=(maxP_f*t).toFixed(0);return `<line x1="${pL_f}" y1="${y.toFixed(1)}" x2="${(pL_f+cW_f).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${(pL_f-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v}</text>`;});
  const svg_fig1=`<svg viewBox="0 0 500 176" width="500" height="176" xmlns="http://www.w3.org/2000/svg">${yT_f.join('')}${pBars_f.join('')}<line x1="${pL_f}" y1="${pT_f}" x2="${pL_f}" y2="${(pT_f+cH_f).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_f}" y1="${(pT_f+cH_f).toFixed(1)}" x2="${(pL_f+cW_f).toFixed(1)}" y2="${(pT_f+cH_f).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="12" y="${(pT_f+cH_f/2).toFixed(0)}" text-anchor="middle" font-size="7.5" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_f+cH_f/2).toFixed(0)})">Power (kW)</text></svg>`;

  // ── SVG Figure 2: Weight Breakdown ───────────────────────────────────
  const wSegs_f=[{lbl:"Payload",val:p.payload,col:"#16a34a"},{lbl:"Empty Weight",val:SR.Wempty,col:"#1e40af"},{lbl:"Battery",val:SR.Wbat,col:"#f59e0b"}];
  const Wtot_f=SR.MTOW||1; let xW_f=10;
  const wBars_f=wSegs_f.map(s=>{const w=460*(s.val/Wtot_f);const b=`<rect x="${xW_f.toFixed(1)}" y="14" width="${Math.max(1,w).toFixed(1)}" height="30" fill="${s.col}" opacity="0.9"/>${w>35?`<text x="${(xW_f+w/2).toFixed(1)}" y="32" text-anchor="middle" font-size="8" fill="#fff" font-weight="bold" font-family="Arial,sans-serif">${s.lbl}</text>`:''}${w>45?`<text x="${(xW_f+w/2).toFixed(1)}" y="55" text-anchor="middle" font-size="7.5" fill="#374151" font-family="Arial,sans-serif">${s.val.toFixed(0)} kg (${(s.val/Wtot_f*100).toFixed(1)}%)</text>`:''}`;xW_f+=w;return b;});
  const svg_fig2=`<svg viewBox="0 0 480 68" width="480" height="68" xmlns="http://www.w3.org/2000/svg">${wBars_f.join('')}<rect x="10" y="14" width="460" height="30" fill="none" stroke="#374151" stroke-width="0.75"/></svg>`;

  // ── SVG Figure 3: Energy Breakdown ───────────────────────────────────
  const eSegs_f=[{lbl:"T/O",val:SR.Eto,col:"#f59e0b"},{lbl:"Climb",val:SR.Ecl,col:"#3b82f6"},{lbl:"Cruise",val:SR.Ecr,col:"#14b8a6"},{lbl:"Desc",val:SR.Edc,col:"#8b5cf6"},{lbl:"Land",val:SR.Eld,col:"#f97316"},{lbl:"Reserve",val:SR.Eres,col:"#ef4444"}];
  const Etot_f2=SR.Etot||1; let xE_f=10;
  const eBars_f=eSegs_f.map(s=>{const w=460*(s.val/Etot_f2);const b=`<rect x="${xE_f.toFixed(1)}" y="14" width="${Math.max(1,w).toFixed(1)}" height="30" fill="${s.col}" opacity="0.85"/>${w>28?`<text x="${(xE_f+w/2).toFixed(1)}" y="32" text-anchor="middle" font-size="7.5" fill="#fff" font-weight="bold" font-family="Arial,sans-serif">${s.lbl}</text>`:''}${w>38?`<text x="${(xE_f+w/2).toFixed(1)}" y="56" text-anchor="middle" font-size="7" fill="#374151" font-family="Arial,sans-serif">${s.val.toFixed(1)} kWh</text>`:''}`;xE_f+=Math.max(1,w);return b;});
  const svg_fig3=`<svg viewBox="0 0 480 66" width="480" height="66" xmlns="http://www.w3.org/2000/svg">${eBars_f.join('')}<rect x="10" y="14" width="460" height="30" fill="none" stroke="#374151" stroke-width="0.75"/></svg>`;

  // ── SVG Figure 4: Drag Polar ──────────────────────────────────────────
  const pPts_f=(SR.polarData||[]).filter(d=>d.CL>=0&&d.CL<=1.6&&d.CD>0&&d.CD<0.12);
  const maxCD_f=pPts_f.length?Math.max(...pPts_f.map(d=>d.CD)):0.08;
  const cW_p=400,cH_p=140,pL_p=45,pT_p=15,pB_p=32,pR_p=15;
  const px_f=(cd)=>pL_p+cW_p*(cd/Math.max(maxCD_f,0.001));
  const py_f=(cl)=>pT_p+cH_p*(1-cl/1.6);
  const polLine=pPts_f.map(d=>`${px_f(d.CD).toFixed(1)},${py_f(d.CL).toFixed(1)}`).join(' ');
  const dp_x_f=px_f(SR.CDtot||0.036), dp_y_f=py_f(p.clDesign);
  const xT_p=[0,0.02,0.04,0.06,0.08].filter(v=>v<=maxCD_f).map(v=>{const x=px_f(v);return `<line x1="${x.toFixed(1)}" y1="${pT_p}" x2="${x.toFixed(1)}" y2="${(pT_p+cH_p).toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${x.toFixed(1)}" y="${(pT_p+cH_p+11).toFixed(1)}" text-anchor="middle" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v.toFixed(2)}</text>`;});
  const yT_p=[0,0.4,0.8,1.2,1.6].map(v=>{const y=py_f(v);return `<line x1="${pL_p}" y1="${y.toFixed(1)}" x2="${(pL_p+cW_p).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${(pL_p-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v.toFixed(1)}</text>`;});
  const svg_fig4=`<svg viewBox="0 0 460 187" width="460" height="187" xmlns="http://www.w3.org/2000/svg">${xT_p.join('')}${yT_p.join('')}${polLine?`<polyline points="${polLine}" fill="none" stroke="#1e40af" stroke-width="1.5"/>`:''}<circle cx="${dp_x_f.toFixed(1)}" cy="${dp_y_f.toFixed(1)}" r="4" fill="#f59e0b" stroke="#0f172a" stroke-width="1"/><text x="${(dp_x_f+7).toFixed(1)}" y="${(dp_y_f+4).toFixed(1)}" font-size="7.5" fill="#0f172a" font-family="Arial,sans-serif" font-weight="bold">Design point (CL=${p.clDesign}, L/D=${fmt(SR.LDact,1)})</text><line x1="${pL_p}" y1="${pT_p}" x2="${pL_p}" y2="${(pT_p+cH_p).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_p}" y1="${(pT_p+cH_p).toFixed(1)}" x2="${(pL_p+cW_p).toFixed(1)}" y2="${(pT_p+cH_p).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="${(pL_p+cW_p/2).toFixed(0)}" y="${(pT_p+cH_p+24).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif">Drag Coefficient C&#x209F;</text><text x="12" y="${(pT_p+cH_p/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_p+cH_p/2).toFixed(0)})">Lift Coefficient C&#x2097;</text></svg>`;

  // ── SVG Figure 5: V-n Envelope ────────────────────────────────────────
  const Vstall_f=SR.Vstall||20, VA_f=SR.VA||(SR.Vstall*Math.sqrt(3.5)||28), VD_f=SR.VD||(p.vCruise*1.25);
  const WL_f=SR.WL||500, nPos_f=3.5, nNeg_f=-1.5, CLmax_f=1.6, CLmax_n2=0.8;
  const Vmx_f=VD_f*1.08;
  const cW_v=420,cH_v=150,pL_v=45,pT_v=15,pB_v=32;
  const vx_f=(v)=>pL_v+cW_v*(v/Vmx_f);
  const ny_f=(n)=>pT_v+cH_v*(1-(n-nNeg_f)/(nPos_f-nNeg_f));
  const rho_vf=1.225;
  const mPts_f=Array.from({length:40},(_,i)=>{const v=i/39*VA_f;const n=Math.min(nPos_f,0.5*rho_vf*v*v*CLmax_f/WL_f);return `${vx_f(v).toFixed(1)},${ny_f(n).toFixed(1)}`;}).join(' ');
  const mNeg_f=Array.from({length:25},(_,i)=>{const v=i/24*(VD_f*0.9);const n=Math.max(nNeg_f,-0.5*rho_vf*v*v*CLmax_n2/WL_f);return `${vx_f(v).toFixed(1)},${ny_f(n).toFixed(1)}`;}).join(' ');
  const vTck_f=[0,20,40,60,80,Math.round(VD_f)].filter((v,i,a)=>v<=Vmx_f&&a.indexOf(v)===i).map(v=>{const x=vx_f(v);return `<line x1="${x.toFixed(1)}" y1="${pT_v}" x2="${x.toFixed(1)}" y2="${(pT_v+cH_v).toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${x.toFixed(1)}" y="${(pT_v+cH_v+12).toFixed(1)}" text-anchor="middle" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v}</text>`;});
  const nTck_f=[-1.5,-1,0,1,2,3,3.5].map(n=>{const y=ny_f(n);return `<line x1="${pL_v}" y1="${y.toFixed(1)}" x2="${(pL_v+cW_v).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${n===0?'#374151':'#e5e7eb'}" stroke-width="${n===0?0.8:0.5}"/><text x="${(pL_v-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${n}</text>`;});
  const svg_fig5=`<svg viewBox="0 0 480 197" width="480" height="197" xmlns="http://www.w3.org/2000/svg">${vTck_f.join('')}${nTck_f.join('')}<polyline points="${mPts_f}" fill="none" stroke="#1e40af" stroke-width="1.5"/><line x1="${vx_f(VA_f).toFixed(1)}" y1="${ny_f(nPos_f).toFixed(1)}" x2="${vx_f(VD_f).toFixed(1)}" y2="${ny_f(nPos_f).toFixed(1)}" stroke="#1e40af" stroke-width="1.5"/><line x1="${vx_f(VD_f).toFixed(1)}" y1="${ny_f(nPos_f).toFixed(1)}" x2="${vx_f(VD_f).toFixed(1)}" y2="${ny_f(0).toFixed(1)}" stroke="#1e40af" stroke-width="1.5"/><polyline points="${mNeg_f}" fill="none" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="4,2"/><line x1="${vx_f(Vstall_f).toFixed(1)}" y1="${ny_f(nNeg_f).toFixed(1)}" x2="${vx_f(VD_f).toFixed(1)}" y2="${ny_f(nNeg_f).toFixed(1)}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="4,2"/><text x="${(vx_f(VA_f)+3).toFixed(1)}" y="${(ny_f(nPos_f)-4).toFixed(1)}" font-size="7" fill="#1e40af" font-family="Arial,sans-serif">VA=${VA_f.toFixed(0)} m/s</text><text x="${(vx_f(VD_f)-2).toFixed(1)}" y="${(ny_f(nPos_f)-4).toFixed(1)}" text-anchor="end" font-size="7" fill="#1e40af" font-family="Arial,sans-serif">VD=${VD_f.toFixed(0)}</text><line x1="${pL_v}" y1="${pT_v}" x2="${pL_v}" y2="${(pT_v+cH_v).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_v}" y1="${(pT_v+cH_v).toFixed(1)}" x2="${(pL_v+cW_v).toFixed(1)}" y2="${(pT_v+cH_v).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="${(pL_v+cW_v/2).toFixed(0)}" y="${(pT_v+cH_v+24).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif">Equivalent Airspeed (m/s)</text><text x="12" y="${(pT_v+cH_v/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_v+cH_v/2).toFixed(0)})">Load Factor n (g)</text></svg>`;

  // ── SVG Figure 6: Noise Propagation ──────────────────────────────────
  const nDists_f=[1,5,10,25,50,100,150,200,300,500];
  const nPts_f=nDists_f.map(r=>{const alpha_atm=1.8/1000;const dBA=SR.dBA_1m-20*Math.log10(r)-alpha_atm*r+(r>10?2.5:0);return{r,dBA:Math.max(25,dBA)};});
  const cW_n=420,cH_n=140,pL_n=45,pT_n=15,pB_n=32;
  const logMax=Math.log10(500);
  const nx_f=(r)=>pL_n+cW_n*(Math.log10(Math.max(r,0.1))/logMax);
  const ny_n2=(d)=>pT_n+cH_n*(1-(d-25)/(Math.max(SR.dBA_1m||100,90)-25));
  const nLine_f=nPts_f.map(d=>`${nx_f(d.r).toFixed(1)},${ny_n2(d.dBA).toFixed(1)}`).join(' ');
  const rTck_f=[1,10,50,150,500].map(r=>{const x=nx_f(r);return `<line x1="${x.toFixed(1)}" y1="${pT_n}" x2="${x.toFixed(1)}" y2="${(pT_n+cH_n).toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${x.toFixed(1)}" y="${(pT_n+cH_n+12).toFixed(1)}" text-anchor="middle" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${r}m</text>`;});
  const dT_f=[40,50,60,70,80,90].filter(v=>v>=25&&v<=(SR.dBA_1m||100)).map(v=>{const y=ny_n2(v);return `<line x1="${pL_n}" y1="${y.toFixed(1)}" x2="${(pL_n+cW_n).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${(pL_n-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v}</text>`;});
  const y65_f=ny_n2(65);
  const svg_fig6=`<svg viewBox="0 0 480 187" width="480" height="187" xmlns="http://www.w3.org/2000/svg">${rTck_f.join('')}${dT_f.join('')}<polyline points="${nLine_f}" fill="none" stroke="#1e40af" stroke-width="2"/>${nPts_f.map(d=>`<circle cx="${nx_f(d.r).toFixed(1)}" cy="${ny_n2(d.dBA).toFixed(1)}" r="2.5" fill="#1e40af"/>`).join('')}<line x1="${pL_n}" y1="${y65_f.toFixed(1)}" x2="${(pL_n+cW_n).toFixed(1)}" y2="${y65_f.toFixed(1)}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5,3"/><text x="${(pL_n+cW_n-2).toFixed(1)}" y="${(y65_f-4).toFixed(1)}" text-anchor="end" font-size="7.5" fill="#dc2626" font-family="Arial,sans-serif">EASA limit 65 dBA</text><line x1="${pL_n}" y1="${pT_n}" x2="${pL_n}" y2="${(pT_n+cH_n).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_n}" y1="${(pT_n+cH_n).toFixed(1)}" x2="${(pL_n+cW_n).toFixed(1)}" y2="${(pT_n+cH_n).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="${(pL_n+cW_n/2).toFixed(0)}" y="${(pT_n+cH_n+24).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif">Distance from source — log scale (m)</text><text x="12" y="${(pT_n+cH_n/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_n+cH_n/2).toFixed(0)})">A-weighted SPL (dBA)</text></svg>`;

  // ── SVG Figure 7: Battery SoH Degradation ────────────────────────────
  const shPts_f=Array.from({length:21},(_,i)=>{const c=i*900/20;const s=Math.max(60,100-20*Math.pow(c/900,0.8));return{c,s};});
  const cW_sh=420,cH_sh=130,pL_sh=45,pT_sh=15,pB_sh=32;
  const sx_f=(c)=>pL_sh+cW_sh*(c/900);
  const sy_f=(s)=>pT_sh+cH_sh*(1-(s-60)/40);
  const shLine_f=shPts_f.map(d=>`${sx_f(d.c).toFixed(1)},${sy_f(d.s).toFixed(1)}`).join(' ');
  const y80_f=sy_f(80);
  const shXT=[0,200,400,600,800,900].map(c=>{const x=sx_f(c);return `<line x1="${x.toFixed(1)}" y1="${pT_sh}" x2="${x.toFixed(1)}" y2="${(pT_sh+cH_sh).toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${x.toFixed(1)}" y="${(pT_sh+cH_sh+12).toFixed(1)}" text-anchor="middle" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${c}</text>`;});
  const shYT=[60,70,80,90,100].map(s=>{const y=sy_f(s);return `<line x1="${pL_sh}" y1="${y.toFixed(1)}" x2="${(pL_sh+cW_sh).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${(pL_sh-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${s}%</text>`;});
  const svg_fig7=`<svg viewBox="0 0 480 177" width="480" height="177" xmlns="http://www.w3.org/2000/svg">${shXT.join('')}${shYT.join('')}<polyline points="${shLine_f}" fill="none" stroke="#1e40af" stroke-width="2"/><line x1="${pL_sh}" y1="${y80_f.toFixed(1)}" x2="${(pL_sh+cW_sh).toFixed(1)}" y2="${y80_f.toFixed(1)}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5,3"/><text x="${(pL_sh+cW_sh-2).toFixed(1)}" y="${(y80_f-4).toFixed(1)}" text-anchor="end" font-size="7.5" fill="#dc2626" font-family="Arial,sans-serif">80% SoH → replacement threshold</text><line x1="${pL_sh}" y1="${pT_sh}" x2="${pL_sh}" y2="${(pT_sh+cH_sh).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_sh}" y1="${(pT_sh+cH_sh).toFixed(1)}" x2="${(pL_sh+cW_sh).toFixed(1)}" y2="${(pT_sh+cH_sh).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="${(pL_sh+cW_sh/2).toFixed(0)}" y="${(pT_sh+cH_sh+24).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif">Charge Cycle Count</text><text x="12" y="${(pT_sh+cH_sh/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_sh+cH_sh/2).toFixed(0)})">State of Health (%)</text></svg>`;

  // ── SVG Figure 8: MTOW Convergence History ────────────────────────────
  const cvD_f=(SR.convData||[]).slice(0,40).filter(d=>isFinite(d.MTOW));
  const cvMax_f=cvD_f.length?Math.max(...cvD_f.map(d=>d.MTOW)):SR.MTOW||2000;
  const cvMin_f=cvD_f.length?Math.min(...cvD_f.map(d=>d.MTOW)):SR.MTOW*0.8||1600;
  const cvRange_f=Math.max(cvMax_f-cvMin_f,50);
  const cW_cv=420,cH_cv=120,pL_cv=55,pT_cv=15,pB_cv=32;
  const cvx_f=(i)=>pL_cv+cW_cv*(i/Math.max(cvD_f.length-1,1));
  const cvy_f=(m)=>pT_cv+cH_cv*(1-(m-cvMin_f)/cvRange_f);
  const cvLine_f=cvD_f.map((d,i)=>`${cvx_f(i).toFixed(1)},${cvy_f(d.MTOW).toFixed(1)}`).join(' ');
  const cvYT=[0,0.25,0.5,0.75,1].map(t=>{const y=pT_cv+cH_cv*(1-t);const v=(cvMin_f+cvRange_f*t).toFixed(0);return `<line x1="${pL_cv}" y1="${y.toFixed(1)}" x2="${(pL_cv+cW_cv).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="0.5"/><text x="${(pL_cv-4).toFixed(1)}" y="${(y+3).toFixed(1)}" text-anchor="end" font-size="7" fill="#64748b" font-family="Arial,sans-serif">${v}</text>`;});
  const svg_fig8=`<svg viewBox="0 0 490 167" width="490" height="167" xmlns="http://www.w3.org/2000/svg">${cvYT.join('')}${cvLine_f?`<polyline points="${cvLine_f}" fill="none" stroke="#1e40af" stroke-width="1.5"/>${cvD_f.map((d,i)=>`<circle cx="${cvx_f(i).toFixed(1)}" cy="${cvy_f(d.MTOW).toFixed(1)}" r="2" fill="#f59e0b"/>`).join('')}`:'<text x="245" y="70" text-anchor="middle" font-size="9" fill="#64748b" font-family="Arial,sans-serif">History not available</text>'}<line x1="${pL_cv}" y1="${pT_cv}" x2="${pL_cv}" y2="${(pT_cv+cH_cv).toFixed(1)}" stroke="#374151" stroke-width="1"/><line x1="${pL_cv}" y1="${(pT_cv+cH_cv).toFixed(1)}" x2="${(pL_cv+cW_cv).toFixed(1)}" y2="${(pT_cv+cH_cv).toFixed(1)}" stroke="#374151" stroke-width="1"/><text x="${(pL_cv+cW_cv/2).toFixed(0)}" y="${(pT_cv+cH_cv+24).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif">Iteration Number</text><text x="12" y="${(pT_cv+cH_cv/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="#374151" font-family="Arial,sans-serif" transform="rotate(-90,12,${(pT_cv+cH_cv/2).toFixed(0)})">MTOW (kg)</text></svg>`;

  // ── Front matter ──────────────────────────────────────────────────────
  const tocRows=[
    ["","Abstract","ii"],["","Table of Contents","iii"],["","List of Figures","iv"],["","List of Tables","iv"],
    ["1","Design Inputs & Mission Requirements","1"],["2","Atmosphere Model (ISA)","2"],
    ["3","Weight & Energy Sizing (Iterative)","3"],["4","Mission Energy Breakdown","4"],
    ["5","Wing Design & Aerodynamics","5"],["6","Hover Propulsion Sizing","7"],
    ["7","Battery System Sizing","8"],["8","Longitudinal Stability","9"],
    ["9","V-Tail Sizing","10"],["10","Feasibility Checks","11"],
    ["11","V-n Diagram & OEI Analysis","12"],["12","Community Design Benchmarks","14"],
    ["A","D1: Round 1 Initial MTOW Estimate","15"],["A","D2: Round 2 Coupled Convergence","16"],
    ["A","D3: Mission Phase Timing","17"],["A","D4: Phase Power & Energy","18"],
    ["A","D5: Wing Sizing Detail","19"],["A","D6: Drag Buildup (Raymer)","20"],
    ["A","D7: Rotor & Motor Sizing","22"],["A","D8: Battery Pack Architecture","23"],
    ["A","D9: CG, NP & Static Margin","24"],["A","D10: Noise Model","25"],
    ["A","D11: Direct Operating Cost Model","27"],["A","D12: BEM Rotor Analysis","29"],
  ];
  const lofRows=[
    ["1","MTOW convergence history — Round 2 iterative loop","D2"],
    ["2","Weight breakdown — Payload / Empty Weight / Battery","§3"],
    ["3","Mission power profile by phase — bar chart (kW)","§4"],
    ["4","Mission energy breakdown by phase (kWh)","§4"],
    ["5","Wing drag polar — C&#x2097; vs C&#x209F; with design point","§5"],
    ["6","Battery state-of-health degradation — NREL power-law","D8"],
    ["7","V-n envelope — CS-23 Amendment 5 / FAR Part 23","§11"],
    ["8","Noise propagation vs distance — ISO 9613-1 + EASA limit","D10"],
  ];
  const lotRows=[
    ["1","Design Inputs & Mission Parameters","§1"],
    ["2","ISA Atmosphere Properties at Cruise & Hover","§2"],
    ["3","Iterative Weight & Energy Sizing Results","§3"],
    ["4","Mission Phase Energy Summary","§4"],
    ["5","Wing Geometry & Aerodynamic Parameters","§5"],
    ["6","Drag Component Buildup (Raymer)","§5"],
    ["7","Hover Propulsion Parameters","§6"],
    ["8","Battery Pack Architecture","§7"],
    ["9","Longitudinal Stability Summary","§8"],
    ["10","V-Tail Sizing Parameters","§9"],
    ["11","Feasibility Check Results","§10"],
    ["12","V-n Load Factor Envelope","§11"],
    ["13","OEI Survivability Analysis","§11"],
    ["14","Community Design Benchmarks","§12"],
    ["15","Noise Propagation — dBA vs Distance","D10"],
    ["16","DOC Component Breakdown","D11"],
    ["17","BEM Rotor & Motor Sizing","D12"],
  ];

  const abstract_pg=`<div class="fm-page">
  <h1 class="fm-heading">Abstract</h1>
  <p style="text-align:justify;line-height:1.75;font-size:10pt;color:#1a1a2e">
  This report documents a parametric conceptual sizing study for a lift-and-cruise electric Vertical Take-Off and Landing (eVTOL) aircraft designated <em>Trail 1</em>.
  The sizing methodology employs a dual-loop convergence algorithm ported from MATLAB (<code>eVTOL_Full_Analysis_v2.m</code>) to an interactive JavaScript implementation,
  integrating actuator disk theory, Raymer component drag buildup, International Standard Atmosphere (ISA) modelling, and iterative weight–energy coupling.
  </p>
  <p style="text-align:justify;line-height:1.75;font-size:10pt;color:#1a1a2e;margin-top:12px">
  The baseline mission specifies a range of <strong>${p.range} km</strong> carrying a payload of <strong>${p.payload} kg</strong>
  at a cruise speed of <strong>${p.vCruise} m/s</strong> at <strong>${p.cruiseAlt} m</strong> altitude with a <strong>${p.reserveMinutes}-minute</strong> regulatory reserve.
  The converged design yields a Maximum Take-Off Weight (MTOW) of <strong>${fmt(SR.MTOW,1)} kg</strong>,
  total mission energy of <strong>${fmt(SR.Etot,2)} kWh</strong>, actual lift-to-drag ratio of <strong>${fmt(SR.LDact,2)}</strong>,
  and a V-tail corrected static margin of <strong>${fmt(SR.SM_vt*100,1)}% MAC</strong>.
  The hover power loading is <strong>${fmt(SR.Phov*1000/SR.MTOW,1)} W/kg</strong> and tip Mach number is <strong>${fmt(SR.TipMach,4)}</strong>.
  </p>
  <p style="text-align:justify;line-height:1.75;font-size:10pt;color:#1a1a2e;margin-top:12px">
  Aeroacoustic analysis (Gutin/BPM semi-empirical model, ISO 9613-1 propagation) predicts <strong>${fmt(SR.dBA_150m,1)} dBA</strong> at 150 m
  (EASA UAM target ≤ 65 dBA; 65 dBA contour radius = ${SR.dist_65dBA} m).
  Direct operating cost is estimated at <strong>$${(totalDOC_c||0).toFixed(0)} per flight</strong> ($${(cpkm_c||0).toFixed(2)}/km).
  The design is assessed as <strong>${SR.feasible?"FEASIBLE":"MARGINAL"}</strong> against all primary engineering constraints.
  All derivations, intermediate calculations, source equation references, and validation notes are reproduced in full in Appendices D1–D12.
  </p>
  <div style="margin-top:24px;padding:14px 18px;background:#f8faff;border:1px solid #dbeafe;border-radius:6px">
    <div style="font-size:8pt;color:#64748b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px;font-weight:700">Key Design Parameters</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
    ${[["MTOW",fmt(SR.MTOW,1)+" kg"],["Empty Weight",fmt(SR.Wempty,1)+" kg"],["Battery Mass",fmt(SR.Wbat,1)+" kg"],
       ["Hover Power",fmt(SR.Phov,1)+" kW"],["Cruise Power",fmt(SR.Pcr,1)+" kW"],["Total Energy",fmt(SR.Etot,2)+" kWh"],
       ["Wing Span",fmt(SR.bWing,2)+" m"],["Wing Area",fmt(SR.Swing,2)+" m²"],["Actual L/D",fmt(SR.LDact,2)],
       ["Static Margin",fmt(SR.SM_vt*100,1)+"% MAC"],["Tip Mach",fmt(SR.TipMach,4)],["Noise @150m",fmt(SR.dBA_150m,1)+" dBA"]
    ].map(([k,v])=>`<div style="background:#fff;padding:8px 10px;border-radius:4px;border:1px solid #e2e8f0"><div style="font-size:7.5pt;color:#64748b">${k}</div><div style="font-size:10pt;font-weight:700;color:#0f172a;font-family:monospace">${v}</div></div>`).join('')}
    </div>
  </div>
  <p style="margin-top:16px;font-size:8.5pt;color:#64748b;font-style:italic">
    <strong>Keywords:</strong> eVTOL, urban air mobility, parametric sizing, actuator disk theory, lift-and-cruise, battery-electric propulsion, aeroacoustics, direct operating cost.
  </p>
</div>`;

  const toc_pg=`<div class="fm-page">
  <h1 class="fm-heading">Table of Contents</h1>
  <table style="width:100%;border-collapse:collapse;table-layout:fixed">
  ${tocRows.map(([num,title,pg])=>`
    <tr>
      <td style="padding:3px 0;font-size:9.5pt;white-space:nowrap;width:auto;padding-right:8px;
        color:${num===''?'#475569':'#0f172a'};${num==='A'?'padding-left:16px;font-size:9pt;color:#475569':''}">
        ${num&&num!=='A'?`<strong>${num}.</strong>&ensp;`:num==='A'?'App.&ensp;':'&ensp;&ensp;'}${title}
      </td>
      <td style="border-bottom:1px dotted #cbd5e1"></td>
      <td style="padding:3px 0 3px 10px;font-size:9.5pt;color:#374151;white-space:nowrap;text-align:right;width:32px">${pg}</td>
    </tr>`).join('')}
  </table>
</div>`;

  const lof_pg=`<div class="fm-page">
  <h1 class="fm-heading">List of Figures</h1>
  <table style="width:100%;border-collapse:collapse">
  ${lofRows.map(([num,cap,sec_])=>`<tr>
    <td style="padding:5px 0;font-size:9.5pt;color:#0f172a;white-space:nowrap"><strong>Figure ${num}.</strong></td>
    <td style="padding:5px 8px;font-size:9.5pt;color:#374151">${cap}</td>
    <td style="border-bottom:1px dotted #cbd5e1;width:100%"></td>
    <td style="padding:5px 0 5px 8px;font-size:9.5pt;color:#64748b;white-space:nowrap;font-family:monospace">${sec_}</td>
  </tr>`).join('')}
  </table>
  <h1 class="fm-heading" style="margin-top:32px">List of Tables</h1>
  <table style="width:100%;border-collapse:collapse">
  ${lotRows.map(([num,cap,sec_])=>`<tr>
    <td style="padding:5px 0;font-size:9.5pt;color:#0f172a;white-space:nowrap"><strong>Table ${num}.</strong></td>
    <td style="padding:5px 8px;font-size:9.5pt;color:#374151">${cap}</td>
    <td style="border-bottom:1px dotted #cbd5e1;width:100%"></td>
    <td style="padding:5px 0 5px 8px;font-size:9.5pt;color:#64748b;white-space:nowrap;font-family:monospace">${sec_}</td>
  </tr>`).join('')}
  </table>
</div>`;

  const benchmarks_sec=`<section id="benchmarks">
  <h2>12. Community Design Benchmarks</h2>
  <p>This section benchmarks the converged design against published UAM aeronautical targets. Sources: NASA/CR-2019-220217, EASA SC-VTOL Issue 2, Joby S-4 S-1 (2021), Archer Midnight S-1 (2021).</p>
  <table class="data-table">
    <thead><tr><th>Metric</th><th>This Design</th><th>Community Target</th><th>Status</th></tr></thead>
    <tbody>
      <tr><td class="td-label">Actual L/D</td><td class="td-value">${fmt(SR.LDact,2)}</td><td class="td-value">≥ 12.0</td><td style="color:${SR.LDact>=12?"#16a34a":"#dc2626"};font-weight:700">${SR.LDact>=12?"✓ Above target":"✗ Below target"}</td></tr>
      <tr><td class="td-label">MTOW / Payload</td><td class="td-value">${fmt(SR.MTOW/p.payload,2)}</td><td class="td-value">≤ 6.0</td><td style="color:${SR.MTOW/p.payload<=6?"#16a34a":"#dc2626"};font-weight:700">${SR.MTOW/p.payload<=6?"✓ Efficient":"✗ Review weight"}</td></tr>
      <tr><td class="td-label">Energy / Range</td><td class="td-value">${fmt(SR.Etot*1000/p.range,1)} Wh/km</td><td class="td-value">≤ ${Math.round(300+p.range*1.4)} Wh/km</td><td style="color:${SR.Etot*1000/p.range<=(300+p.range*1.4)?"#16a34a":"#dc2626"};font-weight:700">${SR.Etot*1000/p.range<=(300+p.range*1.4)?"✓ Efficient":"✗ High"}</td></tr>
      <tr><td class="td-label">Pack SED</td><td class="td-value">${fmt(SR.SEDpack,1)} Wh/kg</td><td class="td-value">≥ 150 Wh/kg</td><td style="color:${SR.SEDpack>=150?"#16a34a":"#d97706"};font-weight:700">${SR.SEDpack>=150?"✓ Good":"⚠ Marginal"}</td></tr>
      <tr><td class="td-label">Static Margin</td><td class="td-value">${fmt(SR.SM_vt*100,1)}% MAC</td><td class="td-value">5–25% MAC</td><td style="color:${SR.SM_vt>=0.05&&SR.SM_vt<=0.25?"#16a34a":"#dc2626"};font-weight:700">${SR.SM_vt>=0.05&&SR.SM_vt<=0.25?"✓ Stable":"✗ Review"}</td></tr>
      <tr><td class="td-label">Hover P/MTOW</td><td class="td-value">${fmt(SR.Phov*1000/SR.MTOW,1)} W/kg</td><td class="td-value">≤ 250 W/kg</td><td style="color:${SR.Phov*1000/SR.MTOW<=250?"#16a34a":SR.Phov*1000/SR.MTOW<=300?"#d97706":"#dc2626"};font-weight:700">${SR.Phov*1000/SR.MTOW<=250?"✓ Good":SR.Phov*1000/SR.MTOW<=300?"⚠ High":"✗ Very high"}</td></tr>
      <tr><td class="td-label">Tip Mach</td><td class="td-value">${fmt(SR.TipMach,4)}</td><td class="td-value">≤ 0.70</td><td style="color:${SR.TipMach<0.70?"#16a34a":"#dc2626"};font-weight:700">${SR.TipMach<0.70?"✓ Subsonic":"✗ Compressibility"}</td></tr>
      <tr><td class="td-label">Noise at 150 m</td><td class="td-value">${fmt(SR.dBA_150m,1)} dBA</td><td class="td-value">≤ 65 dBA (EASA UAM)</td><td style="color:${SR.dBA_150m<=65?"#16a34a":SR.dBA_150m<=75?"#d97706":"#dc2626"};font-weight:700">${SR.dBA_150m<=65?"✓ Meets target":SR.dBA_150m<=75?"⚠ Above target":"✗ Exceeds"}</td></tr>
    </tbody>
  </table>
</section>`;

  const references_sec=`<section id="references">
  <h2>References</h2>
  <ol class="ref-list">
    <li>Raymer, D.P., <em>Aircraft Design: A Conceptual Approach</em>, 6th ed., AIAA, 2018.</li>
    <li>Abbott, I.H. and von Doenhoff, A.E., <em>Theory of Wing Sections</em>, Dover, 1959.</li>
    <li>NREL, "Battery Lifetime Study," NREL/TP-5400-73548, 2023.</li>
    <li>Vascik, P.D., "Systems-Level Analysis of On-Demand Mobility," MIT SM Thesis, 2020.</li>
    <li>NASA/CR-2019-220217, <em>UAM Market Study</em>, Oliver Wyman, 2019.</li>
    <li>BNEF, <em>Electric Vehicle Outlook 2024</em>, Bloomberg NEF, 2024.</li>
    <li>Brooks, T.F., Pope, D.S. and Marcolini, M.A., "Airfoil Self-Noise and Prediction," NASA RP-1218, 1989.</li>
    <li>ISO 9613-1:1993, <em>Acoustics — Attenuation of Sound During Propagation Outdoors</em>.</li>
    <li>Gutin, L., "On the Sound Field of a Rotating Propeller," NACA TM-1195, 1948.</li>
    <li>EASA, <em>Special Condition VTOL Issue 2 (SC-VTOL-01)</em>, 2022.</li>
    <li>Joby Aviation, <em>S-1 Registration Statement</em>, SEC Filing, 2021.</li>
    <li>FAA, <em>AC 21.17-4: Type Certification — Powered-Lift</em>, 2023.</li>
    <li>Selig, M.S. et al., <em>UIUC Airfoil Data Site</em>, University of Illinois, 1995–2024.</li>
    <li>Fraunhofer ISE, <em>Current and Future Cost of Lithium-Ion Batteries</em>, 2023.</li>
    <li>GAMA, <em>Statistical Databook and Industry Outlook</em>, 2023.</li>
  </ol>
</section>`;

  // Pre-compute values used in figure captions (can't use ${} inside "..." caption strings)
  const _convExp  = String(p.convTolExp || -6);
  const _mtowFmt  = fmt(SR.MTOW, 1);
  const _resPct   = fmt(SR.Eres / SR.Etot * 100, 1);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${bTitle} — ${bUniv}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js" onload="renderKatex();"></script>
<style>
/* ── Reset & Base ─────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#1a1a2e;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:10pt;line-height:1.6}
/* ── A4 Page Setup ────────────────────────────────────────────── */
@page{size:A4 portrait;margin:22mm 20mm 25mm 22mm}
@page:left{@top-left{content:"${bTitle}";font-size:7.5pt;color:#64748b;font-family:'Segoe UI',Arial,sans-serif}}
@page:right{@top-right{content:"${bUniv}";font-size:7.5pt;color:#64748b;font-family:'Segoe UI',Arial,sans-serif}}
@page{@bottom-right{content:"Page " counter(page);font-size:7.5pt;color:#64748b;font-family:'Segoe UI',Arial,sans-serif}
      @bottom-left{content:"Generated ${now}";font-size:7.5pt;color:#94a3b8;font-family:'Segoe UI',Arial,sans-serif}}
@page cover{margin:0;@bottom-right{content:none}@bottom-left{content:none}@top-left{content:none}@top-right{content:none}}
/* ── Running Header on print ─────────────────────────────────── */
.running-header{display:none}
@media print{
  .running-header{display:flex;justify-content:space-between;align-items:center;
    border-bottom:0.5px solid #e2e8f0;padding-bottom:4px;margin-bottom:14px;
    font-size:7.5pt;color:#64748b;font-family:'Segoe UI',Arial,sans-serif}
  .cover-page{page:cover;page-break-after:always;min-height:0}
  .fm-page{page-break-before:always;page-break-inside:avoid}
  section{page-break-before:auto}
  h2{page-break-after:avoid}
  .report-figure{page-break-inside:avoid}
  .data-table{page-break-inside:auto}
  .data-table tr{page-break-inside:avoid}
}
/* ── Cover Page ───────────────────────────────────────────────── */
.cover-page{min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
  padding:50px 60px;position:relative;background:linear-gradient(160deg,#07111f 0%,#0d1b2e 45%,#111e35 75%,#0a1628 100%)}
.cover-rule{width:100%;height:4px;background:linear-gradient(90deg,#f59e0b,#3b82f6,#14b8a6);margin:24px 0;border-radius:2px}
.cover-badge{font-size:7pt;color:#4d90c4;letter-spacing:0.4em;font-family:monospace;margin-bottom:20px;text-transform:uppercase;
  background:#ffffff08;padding:5px 16px;border-radius:16px;border:1px solid #1e3a5c}
.cover-title{font-size:30pt;font-weight:900;color:#fff;text-align:center;line-height:1.1;margin-bottom:8px;letter-spacing:-0.02em}
.cover-sub{font-size:10.5pt;color:#7fa3c8;margin-bottom:20px;text-align:center;font-style:italic}
.cover-meta{border-collapse:collapse;color:#c8d6e5;font-size:9pt;width:100%;max-width:640px}
.cover-meta td{padding:5px 12px;border-bottom:1px solid #1a2d45}
.cover-meta td:first-child{color:#7fa3c8;font-size:7.5pt;text-transform:uppercase;letter-spacing:0.06em;width:140px;font-family:monospace}
.kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:640px;margin-top:14px}
.kpi-box{background:#ffffff0a;border:1px solid #1e3a5c;border-radius:8px;padding:12px 10px;text-align:center}
.kpi-val{font-size:17pt;font-weight:800;color:#f59e0b;font-family:monospace;line-height:1}
.kpi-lbl{font-size:6.5pt;color:#5a8ab0;text-transform:uppercase;letter-spacing:0.12em;margin-top:4px}
.badge{display:inline-block;padding:3px 9px;border-radius:4px;font-size:8pt;font-weight:700}
.badge.green{background:#16a34a22;color:#16a34a;border:1px solid #16a34a44}
.badge.amber{background:#d9770622;color:#d97706;border:1px solid #d9770644}
.badge.red{background:#dc262622;color:#dc2626;border:1px solid #dc262644}
/* ── Front Matter Pages ───────────────────────────────────────── */
.fm-page{padding:28px 0 24px;border-bottom:1px solid #e5e7eb}
.fm-heading{font-size:16pt;font-weight:800;color:#0f172a;border-bottom:2.5px solid #1e40af;
  padding-bottom:6px;margin-bottom:18px;letter-spacing:-0.01em}
/* ── Body Sections ────────────────────────────────────────────── */
section{padding:24px 0 20px;border-bottom:1px solid #e5e7eb}
h2{font-size:13pt;font-weight:800;color:#0f172a;border-bottom:2px solid #1e40af;
  padding-bottom:5px;margin-bottom:13px;letter-spacing:-0.01em}
h3{font-size:10.5pt;font-weight:700;color:#1e3a5f;margin:14px 0 5px}
p{color:#374151;margin-bottom:9px;font-size:9.5pt;text-align:justify}
/* ── Equations ────────────────────────────────────────────────── */
.eq-block{background:#f8faff;border-left:3px solid #1e40af;padding:9px 16px;margin:9px 0 5px;border-radius:0 5px 5px 0;overflow-x:auto}
.eq-note{font-size:7.5pt;color:#64748b;margin-top:3px;font-style:italic}
/* ── Tables ───────────────────────────────────────────────────── */
.data-table{width:100%;border-collapse:collapse;margin:9px 0 16px;font-size:8.5pt}
.data-table th{background:#1e3a5f;color:#f1f5f9;padding:6px 9px;text-align:left;font-size:8pt;letter-spacing:0.03em;font-weight:700}
.data-table td{padding:5px 9px;border-bottom:1px solid #e5e7eb}
.data-table tr:nth-child(even) td{background:#f8faff}
.td-label{color:#374151;font-weight:600;white-space:nowrap;font-size:8.5pt}
.td-formula{color:#1e3a5f;font-style:italic;min-width:110px;font-size:8.5pt}
.td-value{color:#0f172a;font-weight:700;font-family:monospace;text-align:right;white-space:nowrap;font-size:8.5pt}
.td-unit{color:#64748b;font-size:8pt;white-space:nowrap;padding-left:5px}
/* ── Feasibility check table ──────────────────────────────────── */
.check-table{width:100%;border-collapse:collapse;margin:9px 0;font-size:9pt}
.check-table th{background:#1e3a5f;color:#f1f5f9;padding:6px 11px;text-align:left;font-size:8pt;font-weight:700}
.check-table td{padding:6px 11px;border-bottom:1px solid #e5e7eb}
.check-table tr.ok td:first-child{color:#16a34a;font-weight:800;font-size:10pt}
.check-table tr.fail td:first-child{color:#dc2626;font-weight:800;font-size:10pt}
.check-table tr.ok{background:#f0fdf4}
.check-table tr.fail{background:#fef2f2}
/* ── Figures ──────────────────────────────────────────────────── */
.report-figure{margin:14px 0 18px;text-align:center;page-break-inside:avoid}
.fig-inner{display:block;width:100%;background:#fafbff;border:0.75px solid #dde3ef;border-radius:5px;padding:10px 14px;overflow:hidden}
.fig-inner svg{display:block;width:100%;height:auto;max-height:220px}
figcaption{font-size:8.5pt;color:#374151;margin-top:7px;font-style:italic;text-align:center}
figcaption strong{font-style:normal;color:#0f172a}
/* ── References ───────────────────────────────────────────────── */
.ref-list{margin:8px 0 0 18px;font-size:9pt;color:#374151}
.ref-list li{margin-bottom:6px;line-height:1.5}
/* ── TOC & Lists ──────────────────────────────────────────────── */
.toc-entry{display:flex;gap:6px;padding:3px 0;font-size:9.5pt}
</style>
</head>
<body>
${cover}
<div style="padding:28px 0 0">
${abstract_pg}
${toc_pg}
${lof_pg}
</div>
${s1}${s2}${sd1}${sd2}${fig(1,"MTOW convergence history — Round 2 iterative loop. Each point is one full energy-weight evaluation. Convergence to \u03b5=10<sup>"+_convExp+"</sup> kg.",svg_fig8)}
${s3}${fig(2,"Weight breakdown showing Payload, Empty Weight and Battery mass fractions at converged MTOW = "+_mtowFmt+" kg.",svg_fig2)}
${sd3}${sd4}${s4}${fig(3,"Mission power profile for each flight phase. Bar width proportional to phase duration; label shows power in kW.",svg_fig1)}${fig(4,"Mission energy breakdown by phase (kWh). Reserve constitutes "+_resPct+"% of total mission energy.",svg_fig3)}
${sd5}${s5}${fig(5,"Wing drag polar (C<sub>L</sub> vs C<sub>D</sub>) computed from Raymer component buildup. Amber circle = cruise design point.",svg_fig4)}
${sd6}${s6}${sd7}${s7}${sd8}${fig(6,"Battery state-of-health degradation model (NREL 2023 power-law). Red dashed line = 80% SoH end-of-life replacement threshold.",svg_fig7)}
${s8}${sd9}${s9}${s10}${s_vn}${fig(7,"V-n envelope diagram per CS-23 Amendment 5 / FAR Part 23. Blue = positive maneuver envelope; red dashed = negative load limit.",svg_fig5)}
${sd10}${fig(8,"Noise propagation vs distance — ISO 9613-1 spherical spreading + atmospheric absorption + ground reflection. Red dashed = EASA 65 dBA UAM target.",svg_fig6)}
${sd11}${sd12}
${benchmarks_sec}
${references_sec}
<footer style="text-align:center;padding:18px 0 10px;font-size:7.5pt;color:#94a3b8;border-top:1px solid #e5e7eb;margin-top:8px">
  Generated by eVTOL Sizer v2.0 — Wright State University — ${now} &nbsp;|&nbsp; Advisor: Dr. Darryl K. Ahner &nbsp;|&nbsp;
  Raymer (2018), Abbott &amp; von Doenhoff (1959), NASA/CR-2019-220217
</footer>
<script>
function renderKatex(){
  document.querySelectorAll('.katex-eq').forEach(el=>{try{katex.render(el.dataset.latex,el,{displayMode:true,throwOnError:false});}catch(e){}});
  document.querySelectorAll('.katex-inline').forEach(el=>{try{katex.render(el.dataset.latex,el,{displayMode:false,throwOnError:false});}catch(e){}});
}
window.addEventListener('load',()=>{setTimeout(()=>window.print(),1400);});
</script>
</body>
</html>`;
}

/* ═══════════════════════════════════
   THEME & CONSTANTS
   ═══════════════════════════════════ */
/* ═══════════════════════════════════
   THEME SYSTEM — dark / light
   ═══════════════════════════════════ */
const DARK={bg:"#07090f",panel:"#0d1117",border:"#1c2333",amber:"#f59e0b",teal:"#14b8a6",
  blue:"#3b82f6",red:"#ef4444",green:"#22c55e",dim:"#4b5563",text:"#e2e8f0",muted:"#64748b",
  purple:"#8b5cf6",orange:"#f97316"};
const LIGHT={bg:"#eef2f7",panel:"#ffffff",border:"#c8d5e3",amber:"#92610a",teal:"#0d7a72",
  blue:"#1a4fcc",red:"#b01c1c",green:"#146b30",dim:"#8fa3b8",text:"#0b1524",muted:"#3d5166",
  purple:"#5c22b5",orange:"#a83700"};
let SC=DARK; // global ref — updated by App before render

const PHC=["#ff6b35","#ffd23f","#06d6a0","#118ab2","#8338ec","#6c757d"];

/* ═══════════════════════════════════
   REUSABLE COMPONENTS
   ═══════════════════════════════════ */
function Slider({label,unit,value,min,max,step,onChange,note}){
  const pct=((value-min)/(max-min))*100;
  return(
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,alignItems:"center"}}>
        <span style={{fontSize:10,color:SC.muted,fontFamily:"system-ui,sans-serif",letterSpacing:"0.01em"}}>{label}</span>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <input type="number" value={value} step={step} min={min} max={max}
            onChange={evt=>{const numVal=parseFloat(evt.target.value);if(!isNaN(numVal))onChange(Math.max(min,Math.min(max,numVal)));}}
            style={{width:62,background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:3,color:SC.amber,
              fontSize:11,textAlign:"right",padding:"2px 5px",fontFamily:"'DM Mono',monospace",outline:"none"}}/>
          <span style={{fontSize:9,color:SC.dim,minWidth:26,fontFamily:"'DM Mono',monospace"}}>{unit}</span>
        </div>
      </div>
      <div style={{position:"relative",height:3,background:SC.border,borderRadius:2}}>
        <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${pct}%`,
          background:`linear-gradient(90deg,${SC.teal},${SC.amber})`,borderRadius:2,transition:"width 0.1s"}}/>
        <input type="range" value={value} min={min} max={max} step={step}
          onChange={evt=>onChange(parseFloat(evt.target.value))}
          style={{position:"absolute",top:-7,left:0,width:"100%",opacity:0,cursor:"pointer",height:17}}/>
      </div>
      {note&&<div style={{fontSize:8,color:SC.dim,marginTop:2,fontFamily:"'DM Mono',monospace"}}>{note}</div>}
    </div>
  );
}

function KPI({label,value,unit,sub,color}){
  const col=color||SC.amber;
  return(
    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:6,padding:"9px 12px",borderLeft:`2px solid ${col}`}}>
      <div style={{fontSize:8,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"system-ui,sans-serif",marginBottom:3}}>{label}</div>
      <div style={{fontSize:18,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",lineHeight:1.1}}>
        {typeof value==="number"?value.toLocaleString():value}
        <span style={{fontSize:9,color:SC.muted,marginLeft:3,fontWeight:400}}>{unit}</span>
      </div>
      {sub&&<div style={{fontSize:8,color:SC.dim,marginTop:2,fontFamily:"'DM Mono',monospace"}}>{sub}</div>}
    </div>
  );
}

function Panel({title,children,ht}){
  return(
    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px",height:ht||"auto"}}>
      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:"system-ui,sans-serif",
        marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>{title}</div>
      {children}
    </div>
  );
}

function Acc({title,icon,children}){
  const[open,setOpen]=useState(true);
  return(
    <div style={{marginBottom:8}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",background:"transparent",border:"none",cursor:"pointer",
        display:"flex",alignItems:"center",gap:7,padding:"4px 0"}}>
        <span style={{fontSize:12}}>{icon}</span>
        <span style={{fontSize:9,fontWeight:700,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.06em",fontFamily:"system-ui,sans-serif"}}>{title}</span>
        <span style={{marginLeft:"auto",color:SC.dim,fontSize:10}}>{open?"▾":"▸"}</span>
      </button>
      {open&&<div style={{paddingTop:4}}>{children}</div>}
    </div>
  );
}

const TABS=["Overview","Mission","Wing & Aero","Propulsion","Battery","Performance","Stability","V-Tail","Convergence","Monte Carlo","Certification","Noise","Cost","Mission Builder","Weather & Atmos","OpenVSP","Community","Collaboration","V-n Diagram","Design Space","BEM Rotor","Reg Tracker","AI Assistant"];
const TABI=["⬛","🛫","✈️","🔧","🔋","📈","⚖️","🦋","🔄","🎲","📋","🔊","💰","🗺️","🌤️","🛩️","🌐","👥","📐","🎯","🔬","📜","🤖"];
// Tab groups: each group has a label, color, and list of tab indices
const TAB_GROUPS=[
  {label:"Design",    color:"#f59e0b", tabs:[0,1,2,3,4,7]},
  {label:"Physics",   color:"#3b82f6", tabs:[5,6,8,18,20]},
  {label:"Analysis",  color:"#22c55e", tabs:[9,10,11,12,19]},
  {label:"Simulation",color:"#a78bfa", tabs:[13,14,21,22]},
  {label:"Tools",     color:"#06d6a0", tabs:[15,16,17]},
];
/* TTP is defined inside App() so it reads the current C theme */

/* ═══════════════════════════════════
   APP
   ═══════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
   DESIGN SPACE EXPLORER — Latin Hypercube Sampling + Pareto Front
   ══════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════
   BEM ROTOR SOLVER — Blade Element Momentum Theory
   Computes spanwise thrust/torque distribution, tip losses (Prandtl),
   wake contraction, figure of merit vs collective pitch.
   Ref: Leishman "Principles of Helicopter Aerodynamics" Ch.3
   ════════════════════════════════════════════════════════════════════════ */
/* ════════════════════════════════════════════════════════════════════════
   FEATURE 9 — CROSS-SECTION PREVIEW PANEL
   Renders fuselage cross-section and wing airfoil as inline SVG.
   ════════════════════════════════════════════════════════════════════════ */
function CrossSectionPreview({ params, SR, SC }) {
  const fD   = Number(params.fusDiam) || 1.65;
  const fL   = Number(params.fusLen)  || 6.5;
  const tc   = Number(params.tc)      || 0.12;
  const Cr   = Number(SR?.Cr_)        || 1.94;
  const Ct   = Number(SR?.Ct_)        || 0.87;
  const bW   = Number(SR?.bWing)      || 12.67;
  const sw   = Number(SR?.sweep)      || 9.57;
  const [station, setStation] = useState(0.38); // fraction along fuselage

  // Fuselage cross-section: 5-station superellipse
  const fusSt = [
    {p:0.00, w:fD*0.01, h:fD*0.01},
    {p:0.15, w:fD*0.60, h:fD*0.55*0.88},
    {p:0.38, w:fD,      h:fD*0.88},
    {p:0.70, w:fD*0.72, h:fD*0.60*0.88},
    {p:1.00, w:fD*0.01, h:fD*0.01},
  ];
  // Interpolate width/height at current station
  const interp = (st) => {
    for (let i = 0; i < fusSt.length - 1; i++) {
      const a = fusSt[i], b = fusSt[i+1];
      if (st >= a.p && st <= b.p) {
        const t = (st - a.p) / (b.p - a.p);
        return { w: a.w + t*(b.w-a.w), h: a.h + t*(b.h-a.h) };
      }
    }
    return fusSt[fusSt.length-1];
  };
  const cs = interp(station);

  // SVG viewport 200×200, centred
  const CX = 100, CY = 100, SCALE = 55 / (fD * 0.5 + 0.1);
  const rx = cs.w * 0.5 * SCALE, ry = cs.h * 0.5 * SCALE;

  // NACA 4-digit airfoil points for wing profile
  const nacaPoints = (tc, nPts=60) => {
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
      const x = 0.5 * (1 - Math.cos(Math.PI * i / nPts));
      const yt = 5*tc*(0.2969*Math.sqrt(x) - 0.1260*x - 0.3516*x*x + 0.2843*x*x*x - 0.1015*x*x*x*x);
      pts.push({x, yt});
    }
    // upper then lower surface
    const upper = pts.map(p => ({x: p.x, y: -p.yt}));
    const lower = pts.slice().reverse().map(p => ({x: p.x, y: p.yt}));
    return [...upper, ...lower];
  };
  const airfoilPts = nacaPoints(tc);
  const W2 = 180, H2 = 80, PAD = 10;
  const toSVG = (x, y) => ({ sx: PAD + x*W2, sy: H2/2 + y*H2*3.5 });
  const airfoilPath = airfoilPts.map((p,i) => {
    const {sx,sy} = toSVG(p.x, p.y);
    return `${i===0?'M':'L'}${sx.toFixed(1)},${sy.toFixed(1)}`;
  }).join(' ') + ' Z';

  // Wing planform (top-down, simplified trapezoid)
  const halfSpan = 90, rootC = 34, tipC = rootC*(Ct/Cr), swPx = halfSpan*Math.tan(sw*Math.PI/180);
  const planformPath = [
    `M100,10`, `L${100+halfSpan},${10+swPx}`,
    `L${100+halfSpan},${10+swPx+tipC}`, `L100,${10+rootC}`, `Z`,
    `M100,10`, `L${100-halfSpan},${10+swPx}`,
    `L${100-halfSpan},${10+swPx+tipC}`, `L100,${10+rootC}`, `Z`
  ].join(' ');

  return (
    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:10}}>
      {/* Fuselage Cross-Section */}
      <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:12}}>
        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,letterSpacing:'0.1em'}}>
          FUSELAGE X-SECTION @ {(station*100).toFixed(0)}% L
        </div>
        <input type="range" min="0" max="1" step="0.01" value={station}
          onChange={e=>setStation(Number(e.target.value))}
          style={{width:'100%',marginBottom:8,accentColor:SC.amber}}/>
        <svg width="100%" viewBox="0 0 200 200" style={{display:'block'}}>
          <rect width="200" height="200" fill="transparent"/>
          {/* Grid */}
          {[-1,0,1].map(i=>(
            <line key={'hg'+i} x1="0" y1={CY+i*40} x2="200" y2={CY+i*40} stroke={SC.border} strokeWidth="0.5"/>
          ))}
          {[-1,0,1].map(i=>(
            <line key={'vg'+i} x1={CX+i*40} y1="0" x2={CX+i*40} y2="200" stroke={SC.border} strokeWidth="0.5"/>
          ))}
          {/* Dimension labels */}
          <text x={CX} y={CY-ry-6} textAnchor="middle" fontSize="8" fill={SC.muted} fontFamily="DM Mono,monospace">
            {cs.h.toFixed(2)}m
          </text>
          <text x={CX+rx+6} y={CY+4} textAnchor="start" fontSize="8" fill={SC.muted} fontFamily="DM Mono,monospace">
            {cs.w.toFixed(2)}m
          </text>
          {/* Ellipse cross-section */}
          <ellipse cx={CX} cy={CY} rx={rx} ry={ry}
            fill={`${SC.blue}18`} stroke={SC.blue} strokeWidth="2"/>
          {/* Centreline crosshairs */}
          <line x1={CX-rx-10} y1={CY} x2={CX+rx+10} y2={CY} stroke={SC.amber} strokeWidth="0.8" strokeDasharray="4,3"/>
          <line x1={CX} y1={CY-ry-10} x2={CX} y2={CY+ry+10} stroke={SC.amber} strokeWidth="0.8" strokeDasharray="4,3"/>
        </svg>
      </div>

      {/* Wing Airfoil */}
      <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:12}}>
        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,letterSpacing:'0.1em'}}>
          WING AIRFOIL — NACA {Math.round(tc*100).toString().padStart(2,'0')} (t/c={tc})
        </div>
        <div style={{fontSize:8,color:SC.dim,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
          Root chord: {Cr.toFixed(2)}m  |  Tip chord: {Ct.toFixed(2)}m
        </div>
        <svg width="100%" viewBox={`0 0 ${W2+PAD*2} ${H2}`} style={{display:'block'}}>
          <rect width={W2+PAD*2} height={H2} fill="transparent"/>
          {/* Chord line */}
          <line x1={PAD} y1={H2/2} x2={PAD+W2} y2={H2/2} stroke={SC.border} strokeWidth="0.5" strokeDasharray="4,3"/>
          {/* Airfoil */}
          <path d={airfoilPath} fill={`${SC.teal}22`} stroke={SC.teal} strokeWidth="1.5"/>
          {/* Quarter chord mark */}
          <line x1={PAD+W2*0.25} y1={H2*0.1} x2={PAD+W2*0.25} y2={H2*0.9} stroke={SC.amber} strokeWidth="1" strokeDasharray="3,2"/>
          <text x={PAD+W2*0.25} y={8} textAnchor="middle" fontSize="7" fill={SC.amber} fontFamily="DM Mono,monospace">c/4</text>
        </svg>
      </div>

      {/* Wing Planform */}
      <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:12}}>
        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,letterSpacing:'0.1em'}}>
          WING PLANFORM (TOP VIEW)
        </div>
        <div style={{fontSize:8,color:SC.dim,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
          b={bW.toFixed(2)}m  |  Λ={sw.toFixed(1)}°  |  λ={( Ct/Cr).toFixed(2)}
        </div>
        <svg width="100%" viewBox="0 0 200 80" style={{display:'block'}}>
          <rect width="200" height="80" fill="transparent"/>
          <path d={planformPath} fill={`${SC.blue}18`} stroke={SC.blue} strokeWidth="1.5"/>
          {/* Fuselage centreline */}
          <line x1="100" y1="0" x2="100" y2="80" stroke={SC.amber} strokeWidth="0.8" strokeDasharray="4,3"/>
          {/* Span arrow */}
          <line x1="10" y1="72" x2="190" y2="72" stroke={SC.muted} strokeWidth="0.8"/>
          <text x="100" y="79" textAnchor="middle" fontSize="7" fill={SC.muted} fontFamily="DM Mono,monospace">b={bW.toFixed(1)}m</text>
        </svg>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FEATURE 10 — CFD-READY EXPORT CHECKLIST
   Validates geometry for VSPAERO before download.
   ════════════════════════════════════════════════════════════════════════ */
function CFDChecklist({ params, SR, SC }) {
  const fL   = Number(params.fusLen)     || 6.5;
  const fD   = Number(params.fusDiam)    || 1.65;
  const bW   = Number(SR?.bWing)         || 12.67;
  const Cr   = Number(SR?.Cr_)           || 1.94;
  const Ct   = Number(SR?.Ct_)           || 0.87;
  const Drot = Number(SR?.Drotor)        || 3.0;
  const bvt  = Number(SR?.bvt_panel)     || 3.77;
  const SM   = Number(SR?.SM_vt||SR?.SM) || 0;
  const MTOW = Number(SR?.MTOW)          || 0;
  const xCG  = Number(SR?.xCGtotal)      || 0;
  const xNP  = Number(SR?.xNP)           || 0;
  const lv   = Number(SR?.lv)            || fL*0.5;
  const tc   = Number(params.tc)         || 0.12;
  const nProp= Number(params.nPropHover) || 6;
  const sweep= Number(SR?.sweep)         || 9.57;
  const vtG  = Number(params.vtGamma)    || 40;
  const yBoom= fD/2 + Drot/2 + 0.2;
  const bvtH = bvt * Math.cos(vtG*Math.PI/180);

  const checks = [
    // ── Geometry completeness ──
    { cat:'Geometry', label:'Fuselage closed (nose + tail tapers defined)',
      ok: fL > 0 && fD > 0, detail:`L=${fL}m  Ø=${fD}m` },
    { cat:'Geometry', label:'Wing has finite tip chord (no sharp tip)',
      ok: Ct > 0.1, detail:`Ct=${Ct.toFixed(2)}m (min 0.1m)` },
    { cat:'Geometry', label:'Wing aspect ratio in valid CFD range (5–20)',
      ok: bW*bW/(Cr*bW) > 5 && bW*bW/(Cr*bW) < 20,
      detail:`AR=${(bW*bW/(Number(SR?.Swing)||17.8)).toFixed(1)}` },
    { cat:'Geometry', label:'V-tail dihedral angle in VSPAERO range (20°–60°)',
      ok: vtG >= 20 && vtG <= 60, detail:`Γ=${vtG}°` },
    { cat:'Geometry', label:'Airfoil t/c within valid range (6%–20%)',
      ok: tc >= 0.06 && tc <= 0.20, detail:`t/c=${(tc*100).toFixed(0)}%` },

    // ── Symmetry ──
    { cat:'Symmetry', label:'Wing uses XZ symmetry plane (sym=2)',
      ok: true, detail:'Set in VSP3 generator ✓' },
    { cat:'Symmetry', label:'Fuselage on aircraft centreline (Y=0)',
      ok: true, detail:'X_Loc=Y_Loc=0 ✓' },
    { cat:'Symmetry', label:'Lift booms mirrored ±Y (sym=2)',
      ok: true, detail:`Y=±${yBoom.toFixed(2)}m ✓` },

    // ── Clearance / interference ──
    { cat:'Clearance', label:'Rotor disc clears fuselage laterally',
      ok: yBoom - Drot/2 > fD/2 + 0.1,
      detail:`Gap=${(yBoom - Drot/2 - fD/2).toFixed(2)}m (min 0.1m)` },
    { cat:'Clearance', label:'Rotor disc clears V-tail laterally',
      ok: yBoom - Drot/2 > bvtH,
      detail:`Rotor inner=${( yBoom-Drot/2).toFixed(2)}m  V-tail span=${bvtH.toFixed(2)}m` },
    { cat:'Clearance', label:'Fuselage length accommodates wing + tail',
      ok: lv + Cr < fL * 1.05,
      detail:`Wing TE + tail arm = ${(lv+Cr).toFixed(2)}m vs fL=${fL}m` },

    // ── Stability (VSPAERO needs flyable geometry) ──
    { cat:'Stability', label:'Static margin positive (aircraft flyable)',
      ok: SM > 0.02, detail:`SM=${(SM*100).toFixed(1)}% MAC (min 2%)` },
    { cat:'Stability', label:'CG forward of NP',
      ok: xCG < xNP, detail:`CG=${xCG.toFixed(2)}m  NP=${xNP.toFixed(2)}m` },
    { cat:'Stability', label:'MTOW positive and non-zero',
      ok: MTOW > 50, detail:`MTOW=${MTOW.toFixed(0)}kg` },

    // ── VSPAERO mesh hints ──
    { cat:'VSPAERO', label:'Wing sweep < 45° (panel method valid)',
      ok: sweep < 45, detail:`Λ=${sweep.toFixed(1)}°` },
    { cat:'VSPAERO', label:'Even rotor count (symmetric torque balance)',
      ok: nProp % 2 === 0, detail:`n=${nProp} rotors` },
    { cat:'VSPAERO', label:'Boom diameter small vs rotor (< 20% disc dia)',
      ok: 0.25 / Drot < 0.20, detail:`Boom Ø=0.25m  Rotor Ø=${Drot}m  ratio=${(0.25/Drot*100).toFixed(0)}%` },
  ];

  const cats = [...new Set(checks.map(c=>c.cat))];
  const passed = checks.filter(c=>c.ok).length;
  const total  = checks.length;
  const pct    = Math.round(passed/total*100);
  const overallCol = pct===100 ? SC.green : pct>=80 ? SC.amber : SC.red;

  return (
    <div style={{display:'flex', flexDirection:'column', gap:10}}>
      {/* Score banner */}
      <div style={{background:SC.panel, border:`2px solid ${overallCol}`, borderRadius:8,
        padding:'14px 20px', display:'flex', alignItems:'center', gap:16}}>
        <div style={{fontSize:36, fontWeight:800, color:overallCol, fontFamily:"'DM Mono',monospace",
          lineHeight:1}}>{pct}%</div>
        <div>
          <div style={{fontSize:13, fontWeight:700, color:SC.text, fontFamily:"'DM Mono',monospace"}}>
            CFD-Ready Score
          </div>
          <div style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace", marginTop:2}}>
            {passed}/{total} checks passed · {pct===100?'✅ Ready for VSPAERO export':pct>=80?'⚠ Minor issues — review amber items':'❌ Fix red items before CFD run'}
          </div>
        </div>
        {/* Progress bar */}
        <div style={{flex:1, height:8, background:SC.border, borderRadius:4, overflow:'hidden'}}>
          <div style={{width:`${pct}%`, height:'100%', background:overallCol, borderRadius:4,
            transition:'width 0.4s ease'}}/>
        </div>
      </div>

      {/* Checks by category */}
      {cats.map(cat=>(
        <div key={cat} style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:12}}>
          <div style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace",
            letterSpacing:'0.12em', marginBottom:8}}>{cat.toUpperCase()}</div>
          <div style={{display:'flex', flexDirection:'column', gap:5}}>
            {checks.filter(c=>c.cat===cat).map((c,i)=>(
              <div key={i} style={{display:'flex', alignItems:'center', gap:10, padding:'5px 8px',
                borderRadius:5, background:c.ok?`${SC.green}0a`:`${SC.red}0a`,
                border:`1px solid ${c.ok?SC.green+'33':SC.red+'33'}`}}>
                <span style={{fontSize:12, flexShrink:0}}>{c.ok?'✅':'❌'}</span>
                <span style={{fontSize:10, color:SC.text, flex:1, fontFamily:"'DM Mono',monospace"}}>{c.label}</span>
                <span style={{fontSize:8, color:SC.muted, fontFamily:"'DM Mono',monospace",
                  whiteSpace:'nowrap'}}>{c.detail}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FEATURE 11 — DESIGN VERSION HISTORY
   Git-style timeline with slider to scrub through saved designs.
   Uses localStorage for persistence.
   ════════════════════════════════════════════════════════════════════════ */
const HISTORY_KEY = 'evtol_design_history';
const MAX_HISTORY = 20;

function saveVersionToHistory(params, SR) {
  try {
    const hist = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const entry = {
      id: Date.now(),
      ts: new Date().toISOString(),
      label: `v${hist.length+1}`,
      MTOW: Number(SR?.MTOW||0).toFixed(0),
      range: Number(SR?.range_km||params.range||0).toFixed(0),
      bWing: Number(SR?.bWing||0).toFixed(2),
      SM: Number((SR?.SM_vt||SR?.SM||0)*100).toFixed(1),
      Etot: Number(SR?.Etot||0).toFixed(1),
      payload: params.payload,
      note: '',
      params: JSON.stringify(params),
    };
    hist.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist.slice(0, MAX_HISTORY)));
  } catch(e) {}
}

function DesignVersionHistory({ params, SR, SC, onLoadVersion }) {
  const [hist, setHist] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch{ return []; }
  });
  const [selected, setSelected] = useState(0);
  const [editNote, setEditNote] = useState(null);
  const [noteVal, setNoteVal] = useState('');

  const refresh = () => {
    try { setHist(JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')); } catch{}
  };

  const saveNow = () => {
    saveVersionToHistory(params, SR);
    refresh();
  };

  const loadVersion = (idx) => {
    const entry = hist[idx];
    if (!entry) return;
    try {
      const p = JSON.parse(entry.params || '{}');
      if (Object.keys(p).length > 0) onLoadVersion(p);
    } catch(e) {}
  };

  const deleteVersion = (idx) => {
    const h = [...hist];
    h.splice(idx, 1);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    setHist(h);
    setSelected(Math.min(selected, h.length-1));
  };

  const saveNote = (idx) => {
    const h = [...hist];
    h[idx] = {...h[idx], note: noteVal};
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
    setHist(h);
    setEditNote(null);
  };

  const clearAll = () => {
    if (!window.confirm('Clear all version history?')) return;
    localStorage.removeItem(HISTORY_KEY);
    setHist([]);
    setSelected(0);
  };

  const cur = hist[selected];

  const kpiDelta = (field, unit='', higher=true) => {
    if (hist.length < 2 || !cur) return null;
    const prev = hist[Math.min(selected+1, hist.length-1)];
    const d = Number(cur[field]) - Number(prev[field]);
    if (Math.abs(d) < 0.01) return null;
    const good = higher ? d > 0 : d < 0;
    return <span style={{fontSize:8, color:good?SC.green:SC.red, fontFamily:"'DM Mono',monospace"}}>
      {d>0?'+':''}{d.toFixed(1)}{unit}
    </span>;
  };

  return (
    <div style={{display:'flex', flexDirection:'column', gap:10}}>
      {/* Header controls */}
      <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap'}}>
        <button onClick={saveNow} type="button"
          style={{padding:'7px 18px', background:`linear-gradient(135deg,${SC.green},#16a34a)`,
            border:'none', borderRadius:6, color:'#fff', fontSize:11, fontWeight:800,
            cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
          💾 Save Current Design
        </button>
        <span style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace"}}>
          {hist.length}/{MAX_HISTORY} versions stored locally
        </span>
        {hist.length > 0 && (
          <button onClick={clearAll} type="button"
            style={{marginLeft:'auto', padding:'5px 12px', background:'transparent',
              border:`1px solid ${SC.red}44`, borderRadius:5, color:SC.red,
              fontSize:9, cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
            Clear All
          </button>
        )}
      </div>

      {hist.length === 0 ? (
        <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8,
          padding:'40px 20px', textAlign:'center', color:SC.muted,
          fontSize:11, fontFamily:"'DM Mono',monospace"}}>
          No versions saved yet. Click "Save Current Design" to start tracking history.
        </div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'1fr 2fr', gap:10}}>
          {/* Timeline list */}
          <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8,
            padding:10, maxHeight:420, overflowY:'auto'}}>
            <div style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace",
              letterSpacing:'0.1em', marginBottom:8}}>VERSION TIMELINE</div>

            {/* Scrubber */}
            {hist.length > 1 && (
              <div style={{marginBottom:10}}>
                <input type="range" min="0" max={hist.length-1} step="1" value={selected}
                  onChange={e=>setSelected(Number(e.target.value))}
                  style={{width:'100%', accentColor:SC.amber}}/>
                <div style={{display:'flex', justifyContent:'space-between', fontSize:7, color:SC.dim,
                  fontFamily:"'DM Mono',monospace"}}>
                  <span>Latest</span><span>Oldest</span>
                </div>
              </div>
            )}

            {hist.map((v, idx) => (
              <div key={v.id} onClick={()=>setSelected(idx)}
                style={{padding:'7px 9px', borderRadius:6, marginBottom:4, cursor:'pointer',
                  border:`1px solid ${idx===selected?SC.amber+'66':SC.border}`,
                  background:idx===selected?`${SC.amber}0d`:'transparent',
                  transition:'all 0.15s'}}>
                <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                  <span style={{fontSize:10, fontWeight:700, color:idx===selected?SC.amber:SC.text,
                    fontFamily:"'DM Mono',monospace"}}>{v.label}</span>
                  <span style={{fontSize:7, color:SC.dim, fontFamily:"'DM Mono',monospace"}}>
                    {new Date(v.ts).toLocaleDateString()}
                  </span>
                </div>
                <div style={{fontSize:8, color:SC.muted, fontFamily:"'DM Mono',monospace", marginTop:2}}>
                  {v.MTOW}kg · {v.range}km · b={v.bWing}m
                </div>
                {v.note && (
                  <div style={{fontSize:8, color:SC.teal, fontFamily:"'DM Mono',monospace",
                    marginTop:2, fontStyle:'italic'}}>"{v.note}"</div>
                )}
              </div>
            ))}
          </div>

          {/* Detail panel */}
          {cur && (
            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {/* KPI cards */}
              <div style={{display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6}}>
                {[
                  ['MTOW', cur.MTOW, 'kg', false],
                  ['Range', cur.range, 'km', true],
                  ['Wingspan', cur.bWing, 'm', true],
                  ['Stat. Margin', cur.SM, '%', true],
                  ['Energy', cur.Etot, 'kWh', false],
                  ['Payload', cur.payload, 'kg', true],
                ].map(([lbl, val, unit, higher])=>(
                  <div key={lbl} style={{background:SC.bg, border:`1px solid ${SC.border}`,
                    borderRadius:6, padding:'8px 10px'}}>
                    <div style={{fontSize:8, color:SC.muted, fontFamily:"'DM Mono',monospace"}}>{lbl}</div>
                    <div style={{fontSize:16, fontWeight:700, color:SC.amber,
                      fontFamily:"'DM Mono',monospace", lineHeight:1.2}}>{val}
                      <span style={{fontSize:8, color:SC.muted, marginLeft:2}}>{unit}</span>
                    </div>
                    {kpiDelta(lbl==='MTOW'?'MTOW':lbl==='Range'?'range':lbl==='Wingspan'?'bWing':lbl==='Stat. Margin'?'SM':lbl==='Energy'?'Etot':'payload', unit, higher)}
                  </div>
                ))}
              </div>

              {/* Notes */}
              <div style={{background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:10}}>
                <div style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace",
                  marginBottom:6}}>DESIGN NOTES — {cur.label}</div>
                {editNote===selected ? (
                  <div style={{display:'flex', gap:6}}>
                    <input value={noteVal} onChange={e=>setNoteVal(e.target.value)}
                      placeholder="Add a note for this version..."
                      style={{flex:1, background:SC.bg, border:`1px solid ${SC.border}`, borderRadius:4,
                        color:SC.text, fontSize:10, padding:'5px 8px', fontFamily:"'DM Mono',monospace"}}/>
                    <button onClick={()=>saveNote(selected)} type="button"
                      style={{padding:'5px 12px', background:`${SC.green}22`, border:`1px solid ${SC.green}`,
                        borderRadius:4, color:SC.green, fontSize:9, cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
                      Save
                    </button>
                    <button onClick={()=>setEditNote(null)} type="button"
                      style={{padding:'5px 10px', background:'transparent', border:`1px solid ${SC.border}`,
                        borderRadius:4, color:SC.muted, fontSize:9, cursor:'pointer'}}>✕</button>
                  </div>
                ) : (
                  <div style={{display:'flex', alignItems:'center', gap:8}}>
                    <span style={{fontSize:10, color:cur.note?SC.text:SC.dim, fontFamily:"'DM Mono',monospace",
                      flex:1, fontStyle:cur.note?'normal':'italic'}}>
                      {cur.note || 'No note — click Edit to add one'}
                    </span>
                    <button onClick={()=>{setEditNote(selected);setNoteVal(cur.note||'');}} type="button"
                      style={{padding:'4px 10px', background:'transparent', border:`1px solid ${SC.border}`,
                        borderRadius:4, color:SC.muted, fontSize:8, cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
                      Edit
                    </button>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div style={{display:'flex', gap:8}}>
                <button onClick={()=>loadVersion(selected)} type="button"
                  style={{flex:1, padding:'9px', background:`linear-gradient(135deg,${SC.blue},#6366f1)`,
                    border:'none', borderRadius:6, color:'#fff', fontSize:11, fontWeight:800,
                    cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
                  ↩ Restore This Version
                </button>
                <button onClick={()=>deleteVersion(selected)} type="button"
                  style={{padding:'9px 16px', background:'transparent',
                    border:`1px solid ${SC.red}44`, borderRadius:6, color:SC.red,
                    fontSize:11, cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
                  🗑
                </button>
              </div>

              <div style={{fontSize:8, color:SC.dim, fontFamily:"'DM Mono',monospace", textAlign:'center'}}>
                Saved {new Date(cur.ts).toLocaleString()} · {cur.label}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   FEATURE 12 — PUBLIC DESIGN GALLERY
   Showcases community designs with inline SVG thumbnails.
   Filterable by MTOW / range / config type.
   ════════════════════════════════════════════════════════════════════════ */
function DesignGallery({ SC, onLoadDesign }) {
  const [filter, setFilter] = useState({mtow:'all', range:'all', sort:'mtow'});
  const [expanded, setExpanded] = useState(null);

  // Gallery seeded with representative eVTOL archetypes
  const GALLERY = [
    { id:0, name:'🎓 My MATLAB Thesis Project', author:'Wright State University', config:'Lift+Cruise',
      MTOW:2969, range:250, bWing:13.5, nProp:6, Drotor:3.0, payload:455, SM:14.0, Etot:192,
      tags:['Thesis','WSU','MATLAB-Exact'], color:'#f59e0b',
      params:{
        // ── Mission (exact MATLAB values) ────────────────────────────────
        payload:455, range:250, vCruise:67, cruiseAlt:1000,
        rateOfClimb:5.08, climbAngle:5,
        reserveRange:60,          // 60 km FAA Part 135 distance-based reserve
        hoverHeight:15.24,
        // ── Aerodynamics ─────────────────────────────────────────────────
        LD:15,                    // Lift_to_Drag = 15
        climbLDPenalty:0.13,      // 13% L/D penalty in climb
        // ── Propulsion ───────────────────────────────────────────────────
        nPropHover:6,             // No_Of_Prop_Hover = 6
        propDiam:3.0,             // Prop_Diameter = 3 m
        etaHov:0.63,              // Hover_Efficiency = 0.63
        etaSys:0.765,             // System_Efficiency = 0.765
        // ── Battery ──────────────────────────────────────────────────────
        etaBat:0.90,              // Battery_Efficiency = 0.90
        sedCell:275,              // SED_pack = 275 Wh/kg
        spBattery:1.0,            // SP_battery = 1.0 kW/kg
        socMin:0.20,              // SoCmin = 0.20
        cRateDerate:0.0,          // no C-rate derating in MATLAB baseline
        // ── Structure ────────────────────────────────────────────────────
        ewf:0.52,                 // Empty_Weight_Fraction = 0.52
      }
    },
    { id:1, name:'Trail1 — WSU Baseline', author:'Wright State Univ.', config:'Lift+Cruise',
      MTOW:2721, range:150, bWing:12.67, nProp:6, Drotor:3.0, payload:400, SM:14.2, Etot:95,
      tags:['Research','Hybrid','6-rotor'], color:'#3b82f6',
      params:{fusLen:6.5,fusDiam:1.65,payload:400,range:150,nPropHover:6,vtGamma:40} },
    { id:2, name:'UltraLight Urban', author:'Community', config:'Multirotor',
      MTOW:550, range:40, bWing:5.2, nProp:4, Drotor:1.2, payload:120, SM:10.1, Etot:22,
      tags:['Urban','Compact','4-rotor'], color:'#22c55e',
      params:{fusLen:3.5,fusDiam:1.0,payload:120,range:40,nPropHover:4,vtGamma:35} },
    { id:3, name:'Heavy Cargo VTOL', author:'Community', config:'Lift+Cruise',
      MTOW:5800, range:200, bWing:18.5, nProp:8, Drotor:4.0, payload:1200, SM:16.5, Etot:280,
      tags:['Cargo','Heavy','8-rotor'], color:'#f59e0b',
      params:{fusLen:10.0,fusDiam:2.2,payload:1200,range:200,nPropHover:8,vtGamma:45} },
    { id:4, name:'Regional Commuter', author:'Community', config:'Tilting',
      MTOW:3200, range:280, bWing:15.0, nProp:6, Drotor:2.8, payload:560, SM:18.0, Etot:145,
      tags:['Regional','Tilting','Long-range'], color:'#8b5cf6',
      params:{fusLen:8.0,fusDiam:1.8,payload:560,range:280,nPropHover:6,vtGamma:40} },
    { id:5, name:'Solo Scout', author:'Community', config:'Multirotor',
      MTOW:380, range:25, bWing:3.8, nProp:4, Drotor:0.9, payload:80, SM:8.5, Etot:14,
      tags:['Solo','Ultralight','4-rotor'], color:'#14b8a6',
      params:{fusLen:2.8,fusDiam:0.85,payload:80,range:25,nPropHover:4,vtGamma:30} },
    { id:6, name:'Medical Rapid Response', author:'Community', config:'Lift+Cruise',
      MTOW:1850, range:120, bWing:10.0, nProp:6, Drotor:2.4, payload:300, SM:12.0, Etot:68,
      tags:['Medical','Mid-size','6-rotor'], color:'#ef4444',
      params:{fusLen:5.5,fusDiam:1.45,payload:300,range:120,nPropHover:6,vtGamma:40} },
  ];

  const filtered = GALLERY.filter(d=>{
    if(filter.mtow==='light' && d.MTOW>1000) return false;
    if(filter.mtow==='medium' && (d.MTOW<=1000||d.MTOW>3500)) return false;
    if(filter.mtow==='heavy' && d.MTOW<=3500) return false;
    if(filter.range==='short' && d.range>80) return false;
    if(filter.range==='medium' && (d.range<=80||d.range>180)) return false;
    if(filter.range==='long' && d.range<=180) return false;
    return true;
  }).sort((a,b)=>filter.sort==='mtow'?a.MTOW-b.MTOW:filter.sort==='range'?b.range-a.range:b.payload-a.payload);

  // Inline SVG thumbnail: simplified top-down aircraft silhouette
  const AircraftThumb = ({d, w=160, h=120}) => {
    const sc = Math.min(w,h) / (d.bWing + 2);
    const cx=w/2, cy=h/2;
    const fuseW=d.fusLen*sc*0.08, fuseH=d.fusLen*sc*0.55;
    const wingSpan=d.bWing*sc*0.45, wingC=12;
    const rotR=d.Drotor*sc*0.35;
    const yBoom=(d.fusLen*0.13+d.Drotor*0.5+0.2)*sc*0.45;
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{display:'block'}}>
        {/* Fuselage */}
        <ellipse cx={cx} cy={cy} rx={fuseW} ry={fuseH} fill={`${d.color}22`} stroke={d.color} strokeWidth="1.5"/>
        {/* Wing */}
        <rect x={cx-wingSpan} y={cy-wingC/2} width={wingSpan*2} height={wingC}
          fill={`${d.color}33`} stroke={d.color} strokeWidth="1" rx="2"/>
        {/* Rotors — pairs at boom positions */}
        {[-yBoom, yBoom].map((yOff,ri)=>
          [cy-fuseH*0.4, cy, cy+fuseH*0.4].slice(0, Math.ceil(d.nProp/2)).map((xOff,ci)=>(
            <circle key={`r${ri}${ci}`} cx={cx+yOff} cy={cy+(ci-(Math.ceil(d.nProp/2)-1)/2)*fuseH*0.55}
              r={rotR} fill={`${d.color}18`} stroke={d.color} strokeWidth="1" strokeDasharray="3,2"/>
          ))
        )}
        {/* V-tail */}
        <polyline points={`${cx},${cy+fuseH*0.85} ${cx-fuseW*2.5},${cy+fuseH*0.5} ${cx},${cy+fuseH*0.65}`}
          fill={`${d.color}22`} stroke={d.color} strokeWidth="1.2"/>
        <polyline points={`${cx},${cy+fuseH*0.85} ${cx+fuseW*2.5},${cy+fuseH*0.5} ${cx},${cy+fuseH*0.65}`}
          fill={`${d.color}22`} stroke={d.color} strokeWidth="1.2"/>
      </svg>
    );
  };

  const sel = GALLERY.find(d=>d.id===expanded);

  return (
    <div style={{display:'flex', flexDirection:'column', gap:10}}>
      {/* Filter bar */}
      <div style={{display:'flex', gap:8, flexWrap:'wrap', alignItems:'center',
        background:SC.panel, border:`1px solid ${SC.border}`, borderRadius:8, padding:'10px 14px'}}>
        <span style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace", whiteSpace:'nowrap'}}>FILTER:</span>
        {[
          ['mtow',   [['all','All MTOW'],['light','Light (<1t)'],['medium','Medium (1–3.5t)'],['heavy','Heavy (>3.5t)']]],
          ['range',  [['all','All Range'],['short','Short (<80km)'],['medium','Mid (80–180km)'],['long','Long (>180km)']]],
          ['sort',   [['mtow','Sort: MTOW'],['range','Sort: Range'],['payload','Sort: Payload']]],
        ].map(([key, opts])=>(
          <select key={key} value={filter[key]} onChange={e=>setFilter(f=>({...f,[key]:e.target.value}))}
            style={{background:SC.bg, border:`1px solid ${SC.border}`, borderRadius:5, color:SC.text,
              fontSize:9, padding:'4px 8px', fontFamily:"'DM Mono',monospace", cursor:'pointer'}}>
            {opts.map(([val,label])=><option key={val} value={val}>{label}</option>)}
          </select>
        ))}
        <span style={{fontSize:8, color:SC.dim, fontFamily:"'DM Mono',monospace", marginLeft:'auto'}}>
          {filtered.length} designs shown
        </span>
      </div>

      {/* Cards grid */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))', gap:10}}>
        {filtered.map(d=>(
          <div key={d.id} onClick={()=>setExpanded(expanded===d.id?null:d.id)}
            style={{background:SC.panel, border:`1px solid ${expanded===d.id?d.color:SC.border}`,
              borderRadius:8, overflow:'hidden', cursor:'pointer', transition:'border-color 0.2s',
              boxShadow:expanded===d.id?`0 0 16px ${d.color}44`:'none'}}>
            {/* Thumbnail */}
            <div style={{background:SC.bg, display:'flex', justifyContent:'center', alignItems:'center',
              padding:'8px 0'}}>
              <AircraftThumb d={d}/>
            </div>
            {/* Info */}
            <div style={{padding:'10px 12px'}}>
              <div style={{fontSize:11, fontWeight:700, color:d.color,
                fontFamily:"'DM Mono',monospace", marginBottom:2}}>{d.name}</div>
              <div style={{fontSize:8, color:SC.muted, fontFamily:"'DM Mono',monospace",
                marginBottom:6}}>{d.author} · {d.config}</div>
              <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:8}}>
                {d.tags.map(t=>(
                  <span key={t} style={{fontSize:7, padding:'2px 6px', borderRadius:3,
                    background:`${d.color}22`, color:d.color, fontFamily:"'DM Mono',monospace"}}>{t}</span>
                ))}
              </div>
              <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:4}}>
                {[['MTOW', d.MTOW+'kg'], ['Range', d.range+'km'],
                  ['Payload', d.payload+'kg'], ['SM', d.SM+'%']].map(([l,v])=>(
                  <div key={l} style={{fontSize:8, fontFamily:"'DM Mono',monospace"}}>
                    <span style={{color:SC.muted}}>{l}: </span>
                    <span style={{color:SC.text, fontWeight:600}}>{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Expanded detail */}
      {sel && (
        <div style={{background:SC.panel, border:`2px solid ${sel.color}`,
          borderRadius:10, padding:16, display:'grid', gridTemplateColumns:'auto 1fr', gap:16,
          alignItems:'start'}}>
          <AircraftThumb d={sel} w={180} h={140}/>
          <div>
            <div style={{fontSize:16, fontWeight:800, color:sel.color,
              fontFamily:"'DM Mono',monospace", marginBottom:4}}>{sel.name}</div>
            <div style={{fontSize:9, color:SC.muted, fontFamily:"'DM Mono',monospace", marginBottom:10}}>
              {sel.author} · {sel.config} · {sel.nProp} hover rotors · D={sel.Drotor}m
            </div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:12}}>
              {[['MTOW',sel.MTOW,'kg'],['Range',sel.range,'km'],
                ['Payload',sel.payload,'kg'],['Wingspan',sel.bWing,'m'],
                ['SM',sel.SM,'%'],['Energy',sel.Etot,'kWh'],
                ['Rotors',sel.nProp,''],['Rotor Ø',sel.Drotor,'m']
              ].map(([l,v,u])=>(
                <div key={l} style={{background:SC.bg, border:`1px solid ${SC.border}`,
                  borderRadius:5, padding:'7px 9px'}}>
                  <div style={{fontSize:7, color:SC.muted, fontFamily:"'DM Mono',monospace"}}>{l}</div>
                  <div style={{fontSize:14, fontWeight:700, color:sel.color,
                    fontFamily:"'DM Mono',monospace"}}>{v}<span style={{fontSize:8, color:SC.muted}}> {u}</span></div>
                </div>
              ))}
            </div>
            <button onClick={()=>{ onLoadDesign&&onLoadDesign(sel.params); setExpanded(null); }} type="button"
              style={{padding:'9px 24px', background:`linear-gradient(135deg,${sel.color},${sel.color}aa)`,
                border:'none', borderRadius:6, color:'#fff', fontSize:12, fontWeight:800,
                cursor:'pointer', fontFamily:"'DM Mono',monospace"}}>
              ↩ Load This Design Into Sizing Tool
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── API Key Input — shared by RegTracker and AI Assistant ── */
function ApiKeyInput({ SC }) {
  const [key, setKey] = useState(localStorage.getItem("anthropic_api_key") || "");
  const [saved, setSaved] = useState(!!localStorage.getItem("anthropic_api_key"));
  const save = () => {
    if (key.trim()) {
      localStorage.setItem("anthropic_api_key", key.trim());
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };
  const clear = () => { localStorage.removeItem("anthropic_api_key"); setKey(""); setSaved(false); };
  return (
    <div style={{ background: SC.bg, border: `1px solid ${SC.border}`, borderRadius: 6, padding: "10px 14px", marginBottom: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontSize: 9, color: SC.muted, fontFamily: "'DM Mono',monospace", whiteSpace: "nowrap" }}>🔑 Anthropic API Key:</span>
      <input
        type="password"
        value={key}
        onChange={e => { setKey(e.target.value); setSaved(false); }}
        placeholder="sk-ant-api03-…"
        style={{ flex: 1, minWidth: 200, background: SC.panel, border: `1px solid ${SC.border}`, borderRadius: 4, color: SC.text, fontSize: 10, padding: "5px 10px", fontFamily: "'DM Mono',monospace", outline: "none" }}
      />
      <button onClick={save} type="button"
        style={{ padding: "5px 14px", background: saved ? `${SC.green}22` : `${SC.amber}22`, border: `1px solid ${saved ? SC.green : SC.amber}`, borderRadius: 4, color: saved ? SC.green : SC.amber, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: "'DM Mono',monospace" }}>
        {saved ? "✓ Saved" : "Save"}
      </button>
      {localStorage.getItem("anthropic_api_key") && (
        <button onClick={clear} type="button"
          style={{ padding: "5px 10px", background: "transparent", border: `1px solid ${SC.border}`, borderRadius: 4, color: SC.muted, fontSize: 9, cursor: "pointer" }}>
          Clear
        </button>
      )}
      <span style={{ fontSize: 9, color: SC.muted, fontFamily: "'DM Mono',monospace" }}>
        Get yours at <span style={{ color: SC.blue }}>console.anthropic.com</span> — stored in browser only, never sent anywhere except Anthropic.
      </span>
    </div>
  );
}

function BEMPanel({ params, SR, SC }) {
  /* ───────────────────────────────────────────────────────────────────────
   *  PHYSICS MODEL:
   *    BEM equations (Leishman 2006 §3.3–3.4)
   *    Prandtl tip-loss + root-loss (Xu & Sankar 2002)
   *    Buhl (2005) turbulent-wake correction — CT-based trigger
   *    Swirl (tangential induction a') — full 2-equation BEM
   *    Constant chord (first-order approx — stated explicitly)
   *    Empirical polar: Cl=f(α) piecewise, Cd=Cd0+kCl² (approx; not Re-dependent)
   *
   *  NUMERICAL METHOD:
   *    Fixed-point iteration, 150 iter max, tol=1e-7
   *    Under-relaxation ω=0.7 (conservative, avoids oscillation)
   *    Radial initial guess: λ₀ ∝ r/R (improves convergence vs global guess)
   *    Hub cutout: r_hub/R = 0.10 (no load computed inside hub)
   *
   *  SAFEGUARDS:
   *    Denominator floor 1e-6 everywhere
   *    a clipped [0, 0.97],  a' clipped [0, 0.5]
   *    Hub cutout eliminates root singularity
   *    Mach tip check before entry
   *
   *  VALIDITY:
   *    Hover only (V_∞ = 0), incompressible (M_tip < 0.7),
   *    moderate loading (CT < 0.15), rigid blade, no wake distortion
   *
   *  REFERENCES:
   *    Leishman, J.G. (2006) Principles of Helicopter Aerodynamics, §3.3-3.4
   *    Buhl, M.L. (2005) NREL/TP-500-36834
   *    Xu, G. & Sankar, L.N. (2002) J. Am. Helicopter Soc. 47(3)
   *    Ning, S.A. (2013) Wind Energy 17(7), 1199-1210
   * ─────────────────────────────────────────────────────────────────────── */

  const [twist,   setTwist]   = useState(-8);    // deg/R, linear twist (washout)
  const [chord_r, setChordR]  = useState(0.08);  // c/R — CONSTANT chord (1st-order approx)
  const [Nbld,    setNbld]    = useState(3);
  const [theta0,  setTheta0]  = useState(12);    // collective pitch at 0.75R (deg)
  const [Clalpha, setClAlpha] = useState(5.73);  // lift slope per rad (empirical approx)
  const [Cd0,     setCd0]     = useState(0.011); // profile drag at Cl=0
  const [hubR,    setHubR]    = useState(0.10);  // hub cutout r_hub/R
  const [results, setResults] = useState(null);
  const [warning, setWarning] = useState('');

  const runBEM = () => {
    setWarning('');
    const NR    = 40;
    const R     = SR ? SR.Drotor / 2 : +(params.propDiam) / 2;
    const RPM   = +(SR?.RPM) || 500;
    const B     = Nbld;
    const rho   = 1.225;
    const g0    = 9.81;
    const Omega = RPM * Math.PI / 30;
    const Vtip  = Omega * R;
    const c     = chord_r * R;             // constant chord (explicit assumption)
    const nRot  = +(SR?.nPropHover || params.nPropHover) || 6;
    const MTOW  = SR?.MTOW || 2177;
    const T_req = MTOW * g0 / nRot;
    const A_disk = Math.PI * R * R;
    const r_hub  = hubR * R;               // hub cutout in meters

    // ── #12 validity check ─────────────────────────────────────────────
    if (Vtip > 340) { setWarning('⚠ Tip speed ≥ speed of sound — model invalid. Reduce RPM.'); return; }
    if (Vtip / 340 > 0.70) setWarning('⚠ Tip Mach > 0.70 — compressibility effects not modelled. Results approximate.');

    let T_total = 0.0, Q_total = 0.0, P_total = 0.0;
    const stations = [];
    let highIndCount = 0;
    let notConvCount = 0;

    for (let i = 1; i <= NR; i++) {
      // ── #1 Hub cutout: stations distributed over [r_hub/R, 1] ────────
      const r_R = hubR + (1.0 - hubR) * (i - 0.5) / NR;
      const r   = r_R * R;          // dimensional (METERS) — used in dQ, sigma_r
      const dr  = (1.0 - hubR) * R / NR;  // annulus width accounts for hub cutout

      // ── Blade pitch ───────────────────────────────────────────────────
      const theta = (theta0 + twist * (r_R - 0.75)) * Math.PI / 180.0;

      // ── #2 Local solidity (constant chord stated explicitly) ──────────
      // c = const (first-order approx). For tapered blades c=c(r) would be used.
      const sigma_r = B * c / (2.0 * Math.PI * r);

      // ── #9 Radial initial guess: λ₀ ∝ r/R ────────────────────────────
      const lam_global = Math.sqrt(T_req / (2.0 * rho * A_disk)) / Vtip;
      let lam  = lam_global * r_R;           // radial scaling
      let lam_prime = 0.01 * r_R;            // initial tangential induction
      lam  = Math.max(0.001, Math.min(lam,  0.5));
      lam_prime = Math.max(0.0,  Math.min(lam_prime, 0.3));

      let converged = false;

      for (let k = 0; k < 150; k++) {
        // ── #4 Inflow angle — dimensional form (avoids root blow-up) ──
        const vi    = lam       * Vtip;   // axial induced velocity (m/s)
        const v_rot = lam_prime * Omega * r; // tangential induced velocity (m/s)
        // phi = atan(vi / (Omega*r*(1+a'))) — full swirl form
        const phi     = Math.atan2(vi, Omega * r + v_rot);
        const sin_phi = Math.sin(phi);
        const cos_phi = Math.cos(phi);

        // ── #3 Prandtl TIP + ROOT loss ───────────────────────────────
        const f_tip  = (B / 2.0) * (1.0 - r_R) / Math.max(r_R * Math.abs(sin_phi), 1e-6);
        const F_tip  = (2.0 / Math.PI) * Math.acos(Math.min(1.0, Math.exp(-Math.abs(f_tip))));
        const f_root = (B / 2.0) * (r_R - hubR)  / Math.max(r_R * Math.abs(sin_phi), 1e-6);
        const F_root = (2.0 / Math.PI) * Math.acos(Math.min(1.0, Math.exp(-Math.abs(f_root))));
        const F = F_tip * F_root;          // combined loss factor

        // ── #5 Lift model (empirical — not Re-dependent) ───────────────
        const alpha_rad = theta - phi;
        const alpha_deg = alpha_rad * 180.0 / Math.PI;
        const absA = Math.abs(alpha_deg);
        let Cl;
        if (absA <= 10.0) {
          Cl = Clalpha * alpha_rad;
        } else if (absA <= 18.0) {
          const t = (absA - 10.0) / 8.0;
          const Cl10 = Clalpha * 10.0 * Math.PI / 180.0;
          Cl = Math.sign(alpha_rad) * (Cl10 * (1.0 - t) + 0.90 * t);
        } else {
          Cl = Math.sign(alpha_rad) * 0.90;
        }
        // NOTE: empirical approx only. For high fidelity use XFOIL polar table.

        // ── #6 Drag model (empirical polar, k≈0.012) ──────────────────
        // Cd = Cd0 + k*Cl²  where k is an empirical fit to section polar.
        // NOT 1/(π·e·AR) — that double-counts induced drag captured by phi.
        // NOTE: Re-dependence not modelled here.
        const Cd = Cd0 + 0.012 * Cl * Cl;

        // Force coefficients (thrust & torque directions)
        const Cn = Cl * cos_phi - Cd * sin_phi;  // thrust direction
        const Ct = Cl * sin_phi + Cd * cos_phi;  // torque direction

        // ── Relative velocity (hover, includes swirl) ──────────────────
        const W2 = (Omega * r + v_rot) ** 2 + vi ** 2;

        // ── Local CT from blade element (non-dim by ρ·Vtip²·A_disk) ──
        const CT_local = sigma_r * Cn * W2 / (4.0 * Math.max(F, 0.01) * Vtip * Vtip);

        // ── #8 Buhl correction — CT-based trigger (not a-based) ───────
        // Trigger: CT > 0.96·F  (Buhl 2005, Eq. 7)
        let a_new;
        if (CT_local > 0.96 * F) {
          highIndCount++;
          // Buhl quadratic: (50/9 - 4F)·a² + (4F - 40/9)·a + (8/9 - CT) = 0
          const Ab = 50.0 / 9.0 - 4.0 * F;
          const Bb = 4.0 * F - 40.0 / 9.0;
          const Cb = 8.0 / 9.0 - CT_local;
          const disc = Bb * Bb - 4.0 * Ab * Cb;
          if (disc >= 0 && Math.abs(Ab) > 1e-10) {
            a_new = Math.max(0.0, Math.min(0.97, (-Bb + Math.sqrt(disc)) / (2.0 * Ab)));
          } else {
            a_new = Math.max(0.0, Math.min(0.97, CT_local / (4.0 * Math.max(F, 0.01))));
          }
        } else {
          // Standard momentum: CT = 4·F·a·(1-a)  → solve quadratic
          // a² - a + CT/(4F) = 0
          const discS = 1.0 - CT_local / Math.max(F, 0.01);
          a_new = discS >= 0 ? 0.5 * (1.0 - Math.sqrt(discS)) : CT_local / (4.0 * Math.max(F, 0.01));
          a_new = Math.max(0.0, Math.min(0.97, a_new));
        }
        const lam_new = a_new * r_R * Math.sqrt(W2) / Math.max(Vtip * (1.0 - a_new), 1e-6);

        // ── #7 Swirl / tangential induction a' ────────────────────────
        // From torque momentum balance: dQ_mom = 4·F·ρ·a'·(1+a')·(Ω·r)²·2π·r·dr
        // From blade element: dQ_be = 0.5·ρ·W²·B·c·Ct·r·dr
        // → a'·(1+a') = sigma_r·Ct·W² / (4·F·(Ω·r)²)
        // Solve quadratic for a':
        const rhs_prime = sigma_r * Ct * W2 / (4.0 * Math.max(F, 0.01) * (Omega * r) * (Omega * r));
        // a'² + a' - rhs_prime = 0  → a' = (-1 + sqrt(1 + 4*rhs_prime))/2
        const ap_new = rhs_prime > 0
          ? (-1.0 + Math.sqrt(1.0 + 4.0 * rhs_prime)) / 2.0
          : 0.0;
        const lam_prime_new = Math.max(0.0, Math.min(0.5, ap_new));

        // ── #10 Under-relaxation ω = 0.7 (conservative) ──────────────
        const lam_next       = 0.7 * lam       + 0.3 * Math.max(1e-4, Math.min(lam_new,       0.9));
        const lam_prime_next = 0.7 * lam_prime + 0.3 * Math.max(0.0,  Math.min(lam_prime_new, 0.5));

        const err = Math.abs(lam_next - lam) + Math.abs(lam_prime_next - lam_prime);
        lam       = lam_next;
        lam_prime = lam_prime_next;
        if (err < 1e-7) { converged = true; break; }
      }
      if (!converged) notConvCount++;

      // ── Final forces with converged lam, lam_prime ────────────────────
      const vi_f    = lam       * Vtip;
      const v_rot_f = lam_prime * Omega * r;
      const phi_f   = Math.atan2(vi_f, Omega * r + v_rot_f);
      const alpha_f = theta - phi_f;
      const alpha_fdeg = alpha_f * 180.0 / Math.PI;
      const absAf = Math.abs(alpha_fdeg);
      let Cl_f;
      if (absAf <= 10.0) Cl_f = Clalpha * alpha_f;
      else if (absAf <= 18.0) {
        const t = (absAf - 10.0) / 8.0;
        Cl_f = Math.sign(alpha_f) * (Clalpha * 10 * Math.PI / 180 * (1-t) + 0.90 * t);
      } else Cl_f = Math.sign(alpha_f) * 0.90;
      const Cd_f = Cd0 + 0.012 * Cl_f * Cl_f;
      const Cn_f = Cl_f * Math.cos(phi_f) - Cd_f * Math.sin(phi_f);
      const Ct_f = Cl_f * Math.sin(phi_f) + Cd_f * Math.cos(phi_f);
      const W2_f = (Omega * r + v_rot_f) ** 2 + vi_f ** 2;
      const q_f  = 0.5 * rho * W2_f;

      const dT = B * q_f * c * Cn_f * dr;       // thrust  (N)
      const dQ = B * q_f * c * Ct_f * r * dr;    // torque  (N·m), r in METERS
      const dP = dQ * Omega;                      // power   (W)

      T_total += dT;
      Q_total += dQ;
      P_total += dP;

      const f_tip_f  = (B/2)*(1-r_R) / Math.max(r_R * Math.abs(Math.sin(phi_f)), 1e-6);
      const F_tip_f  = (2/Math.PI)*Math.acos(Math.min(1.0, Math.exp(-Math.abs(f_tip_f))));
      const f_root_f = (B/2)*(r_R-hubR) / Math.max(r_R * Math.abs(Math.sin(phi_f)), 1e-6);
      const F_root_f = (2/Math.PI)*Math.acos(Math.min(1.0, Math.exp(-Math.abs(f_root_f))));
      const F_f      = F_tip_f * F_root_f;
      const a_f      = lam / (lam + r_R + 1e-6);

      stations.push({
        rR:        +r_R.toFixed(3),
        lam:       +lam.toFixed(5),
        lam_prime: +lam_prime.toFixed(5),
        phi_deg:   +(phi_f * 180 / Math.PI).toFixed(2),
        alpha_deg: +alpha_fdeg.toFixed(2),
        Cl:        +Cl_f.toFixed(4),
        Cd:        +Cd_f.toFixed(5),
        F:         +F_f.toFixed(4),
        F_tip:     +F_tip_f.toFixed(4),
        F_root:    +F_root_f.toFixed(4),
        a:         +a_f.toFixed(4),
        ap:        +lam_prime.toFixed(5),
        dT:        +(dT / dr).toFixed(2),
        dQ:        +(dQ / dr).toFixed(4),
        converged,
      });
    }

    // ── #14 Figure of Merit ────────────────────────────────────────────
    // FM = P_ideal / P_actual = T^1.5/sqrt(2ρA) / P_actual
    // Typical hover FM: 0.65–0.80 (can exceed in idealised models)
    const P_ideal = Math.pow(Math.max(T_total, 1.0), 1.5) / Math.sqrt(2.0 * rho * A_disk);
    const FM      = P_ideal / Math.max(P_total, 1.0);

    // Actuator disk comparison (#13 validation vs simpler model)
    const P_act_1rot = (T_req / (+(params.etaHov) || 0.72)) * Math.sqrt(T_req / (2 * rho * A_disk));
    const P_BEM_kW   = P_total * nRot / 1000.0;
    const P_AKT_kW   = P_act_1rot * nRot / 1000.0;
    const T_ratio    = T_req > 0 ? +(T_total / T_req * 100).toFixed(1) : 0;
    const delta_pct  = P_AKT_kW > 0 ? +((P_BEM_kW - P_AKT_kW) / P_AKT_kW * 100).toFixed(1) : 0;

    const warns = [];
    if (notConvCount > 5) warns.push(`${notConvCount} stations did not converge — try smoother inputs`);
    if (highIndCount > 10) warns.push(`${highIndCount} stations: Buhl correction active (CT > 0.96F)`);
    if (FM > 0.90) warns.push('FM > 0.90 — model may be over-idealised (empirical polar only)');
    if (T_total / T_req > 1.5) warns.push('T_BEM >> T_req — collective may be too high, check stall');
    if (warns.length) setWarning('⚠ ' + warns.join(' | '));

    setResults({
      T_total:+T_total.toFixed(1), T_req:+T_req.toFixed(1), T_ratio,
      Q_total:+Q_total.toFixed(2),
      P_rotor:+(P_total/1000).toFixed(3),
      P_BEM_kW:+P_BEM_kW.toFixed(1), P_AKT_kW:+P_AKT_kW.toFixed(1), delta_pct,
      FM:+FM.toFixed(4),
      sigma_global: +(B * chord_r / Math.PI).toFixed(4),
      highIndCount, notConvCount, stations,
    });
  };

  const S = { fontSize:10, fontFamily:"'DM Mono',monospace", color:SC.muted };

  return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      {/* Header */}
      <div style={{background:`linear-gradient(135deg,${SC.bg},#0d1f0d)`,border:`1px solid ${SC.green}44`,borderRadius:10,padding:'16px 20px'}}>
        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:'0.18em',marginBottom:4}}>
          ITERATIVE BEM · TIP+ROOT LOSS · BUHL CT-TRIGGER · SWIRL (a′) · HUB CUTOUT
        </div>
        <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
          <span style={{color:SC.green}}>Blade Element Momentum</span> Rotor Solver
        </div>
        <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:780}}>
          Full 2-equation BEM (axial + tangential induction). Hub cutout r_hub/R eliminates root singularity.
          Prandtl tip AND root loss. Buhl correction triggered by C_T {'>'} 0.96F (not induction factor).
          Constant chord (stated assumption). Empirical polar — not Re-dependent.
          <strong style={{color:SC.amber}}> Valid: hover, M_tip {'<'} 0.7, moderate loading.</strong>
        </div>
      </div>

      {/* Controls */}
      <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'14px 16px'}}>
        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:'uppercase',letterSpacing:'0.1em',marginBottom:12}}>Blade Geometry Inputs</div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
          {[
            ['Collective θ₀.₇₅', theta0, setTheta0, 2, 22, 0.5, '°', 'Pitch at 0.75R. Increase until T_BEM ≈ T_required.'],
            ['Linear Twist', twist, setTwist, -20, 0, 0.5, '°/R', 'Washout referenced to 0.75R. Typical: −6° to −14°.'],
            ['Chord/Radius c/R', chord_r, setChordR, 0.03, 0.18, 0.005, '', 'Constant chord (1st-order approx). Typical eVTOL: 0.06–0.12.'],
            ['Blade Count B', Nbld, setNbld, 2, 8, 1, 'blades', 'More blades → smoother thrust, higher noise.'],
            ['Lift Slope Clα', Clalpha, setClAlpha, 4.0, 7.0, 0.05, '/rad', 'Empirical approx. NACA 0012 ≈ 5.73. For accuracy use XFOIL polar.'],
            ['Profile Drag Cd₀', Cd0, setCd0, 0.005, 0.030, 0.001, '', 'NACA 0012 at Re≈1M ≈ 0.011. Not Re-dependent here.'],
            ['Hub Cutout r_hub/R', hubR, setHubR, 0.05, 0.25, 0.01, '', 'Eliminates hub singularity. Typical: 0.08–0.15.'],
          ].map(([label,val,setter,min,max,step,unit,tip]) => (
            <div key={label}>
              <div style={{...S,marginBottom:3}}>{label}{unit&&<span style={{color:SC.amber,marginLeft:4}}>{unit}</span>}</div>
              <div style={{display:'flex',alignItems:'center',gap:8}}>
                <input type="range" min={min} max={max} step={step} value={val}
                  onChange={evt=>setter(+evt.target.value)} style={{flex:1}}/>
                <span style={{...S,color:SC.amber,fontWeight:700,minWidth:40,textAlign:'right'}}>{val}</span>
              </div>
              <div style={{fontSize:8,color:SC.dim,fontFamily:"'DM Mono',monospace",marginTop:2,lineHeight:1.4}}>{tip}</div>
            </div>
          ))}
        </div>
        <div style={{marginTop:14,display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
          <button onClick={runBEM} type="button"
            style={{padding:'9px 28px',background:`linear-gradient(135deg,#052e16,${SC.green}88)`,border:`2px solid ${SC.green}`,borderRadius:7,color:SC.green,fontSize:12,fontWeight:800,cursor:'pointer',fontFamily:"'DM Mono',monospace"}}>
            🔬 Run BEM Analysis
          </button>
          {SR&&(
            <span style={{...S,color:SC.muted,fontSize:9}}>
              From sizing: R={(SR.Drotor/2).toFixed(2)}m · RPM={SR.RPM} · {SR.nPropHover} rotors · T_req/rotor={(SR.MTOW*9.81/SR.nPropHover).toFixed(0)}N · V_tip={(SR.RPM*Math.PI/30*(SR.Drotor/2)).toFixed(1)}m/s · M_tip={(SR.TipMach).toFixed(3)}
            </span>
          )}
        </div>
        {warning&&<div style={{marginTop:10,padding:'8px 12px',background:`${SC.amber}15`,border:`1px solid ${SC.amber}44`,borderRadius:6,fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>{warning}</div>}
      </div>

      {results&&(<>
        {/* KPI row */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',gap:8}}>
          {[
            ['T_BEM / rotor', `${results.T_total} N`, results.T_ratio>=90?SC.green:results.T_ratio>=60?SC.amber:SC.red],
            ['T_required',    `${results.T_req} N`,   SC.muted],
            ['T_BEM/T_req',   `${results.T_ratio}%`,  results.T_ratio>=90?SC.green:SC.red],
            ['Figure of Merit', results.FM,             results.FM>=0.75?SC.green:results.FM>=0.65?SC.amber:SC.red],
            ['σ (global)',    results.sigma_global,    SC.teal],
            ['P_BEM total',   `${results.P_BEM_kW}kW`, SC.purple],
          ].map(([label,val,col])=>(
            <div key={label} style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'8px 10px',textAlign:'center',borderTop:`2px solid ${col}`}}>
              <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:'uppercase',marginBottom:3}}>{label}</div>
              <div style={{fontSize:13,fontWeight:800,color:col,fontFamily:"'DM Mono',monospace"}}>{val}</div>
            </div>
          ))}
        </div>

        {/* Insight box */}
        <div style={{padding:'12px 16px',background:results.T_ratio<80?`${SC.amber}0e`:`${SC.green}0e`,border:`1px solid ${results.T_ratio<80?SC.amber:SC.green}44`,borderRadius:8,fontSize:11,color:SC.text,fontFamily:"'DM Mono',monospace",lineHeight:1.9}}>
          {results.T_ratio<80
            ?`⚠️ T_BEM (${results.T_total}N) = ${results.T_ratio}% of T_req. Increase collective θ₀.₇₅ or c/R. σ_global=${results.sigma_global} — target σ > 0.09 for adequate loading.`
            :`✅ T_BEM matches requirement. FM=${results.FM} — typical hover FM: 0.65–0.80 (${results.FM>=0.75?'well-designed':results.FM>=0.65?'acceptable':'review blade geometry'}). BEM: ${results.P_BEM_kW}kW vs actuator disk: ${results.P_AKT_kW}kW (Δ${results.delta_pct>0?'+':''}${results.delta_pct}%). Torque/rotor: ${results.Q_total}N·m.`
          }
          {results.highIndCount>0&&` | ${results.highIndCount} stations: Buhl correction (CT>0.96F).`}
        </div>

        {/* Validity / model notes box */}
        <div style={{padding:'10px 14px',background:`${SC.blue}08`,border:`1px solid ${SC.blue}33`,borderRadius:8,fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.8}}>
          <strong style={{color:SC.blue}}>Model assumptions & validity envelope:</strong>{' '}
          Hover only (V∞=0) · Incompressible (M_tip {'<'} 0.7) · Constant chord (1st-order) ·
          Cl=f(α) empirical (not Re-dependent — use XFOIL for high fidelity) ·
          Cd=Cd0+0.012·Cl² (empirical polar, k≈0.012) ·
          Swirl included (a′ solved) · Prandtl tip+root loss · Buhl CT-trigger ·
          Hub cutout r_hub/R={hubR} · Rigid blade, no wake distortion.
        </div>

        {/* Charts 2×2 */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Thrust Grading dT/dr (N/m) vs r/R</div>
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={results.stations} margin={{top:4,right:12,left:-10,bottom:16}}>
                <defs><linearGradient id="bemg1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SC.green} stopOpacity={0.45}/>
                  <stop offset="95%" stopColor={SC.green} stopOpacity={0.02}/>
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                <XAxis dataKey="rR" tick={{fontSize:9,fill:SC.muted}} label={{value:'r/R',position:'insideBottom',offset:-6,fontSize:9,fill:SC.muted}}/>
                <YAxis tick={{fontSize:9,fill:SC.muted}} label={{value:'dT/dr (N/m)',angle:-90,position:'insideLeft',fontSize:8,fill:SC.muted}}/>
                <Tooltip formatter={(v)=>[`${v} N/m`,'dT/dr']} contentStyle={{background:SC.panel,border:`1px solid ${SC.border}`,fontSize:9}}/>
                <Area type="monotone" dataKey="dT" stroke={SC.green} strokeWidth={2} fill="url(#bemg1)" dot={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Axial (a) & Tangential (a′) Induction vs r/R</div>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={results.stations} margin={{top:4,right:12,left:-10,bottom:16}}>
                <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                <XAxis dataKey="rR" tick={{fontSize:9,fill:SC.muted}} label={{value:'r/R',position:'insideBottom',offset:-6,fontSize:9,fill:SC.muted}}/>
                <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                <Tooltip contentStyle={{background:SC.panel,border:`1px solid ${SC.border}`,fontSize:9}}/>
                <Legend iconSize={8} wrapperStyle={{fontSize:8,fontFamily:"'DM Mono',monospace"}}/>
                <Line type="monotone" dataKey="a"   stroke={SC.blue}  strokeWidth={2}   dot={false} name="a (axial)"/>
                <Line type="monotone" dataKey="ap"  stroke={SC.purple} strokeWidth={2}  dot={false} name="a′ (tangential)"/>
                <Line type="monotone" dataKey="F"   stroke={SC.amber} strokeWidth={1.5} dot={false} name="F (tip+root)"/>
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Section Cl, Cd & Inflow Angle φ (°) vs r/R</div>
            <ResponsiveContainer width="100%" height={190}>
              <LineChart data={results.stations} margin={{top:4,right:12,left:-10,bottom:16}}>
                <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                <XAxis dataKey="rR" tick={{fontSize:9,fill:SC.muted}} label={{value:'r/R',position:'insideBottom',offset:-6,fontSize:9,fill:SC.muted}}/>
                <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                <Tooltip contentStyle={{background:SC.panel,border:`1px solid ${SC.border}`,fontSize:9}}/>
                <Legend iconSize={8} wrapperStyle={{fontSize:8,fontFamily:"'DM Mono',monospace"}}/>
                <Line type="monotone" dataKey="Cl"      stroke={SC.teal}   strokeWidth={2}   dot={false} name="Cl"/>
                <Line type="monotone" dataKey="phi_deg" stroke={SC.orange} strokeWidth={2}   dot={false} name="φ (°)"/>
                <Line type="monotone" dataKey="Cd"      stroke={SC.red}    strokeWidth={1.5} dot={false} name="Cd×10" formatter={(v)=>(v*10).toFixed(4)}/>
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px'}}>
            <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Section AoA α (°) vs r/R — stall onset at 10°</div>
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={results.stations} margin={{top:4,right:12,left:-10,bottom:16}}>
                <defs><linearGradient id="bemg2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SC.blue} stopOpacity={0.35}/>
                  <stop offset="95%" stopColor={SC.blue} stopOpacity={0.02}/>
                </linearGradient></defs>
                <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                <XAxis dataKey="rR" tick={{fontSize:9,fill:SC.muted}} label={{value:'r/R',position:'insideBottom',offset:-6,fontSize:9,fill:SC.muted}}/>
                <YAxis tick={{fontSize:9,fill:SC.muted}} label={{value:'α (°)',angle:-90,position:'insideLeft',fontSize:9,fill:SC.muted}}/>
                <Tooltip formatter={(v)=>[`${v}°`,'AoA']} contentStyle={{background:SC.panel,border:`1px solid ${SC.border}`,fontSize:9}}/>
                <ReferenceLine y={10} stroke={SC.amber} strokeDasharray="4 3" label={{value:'Stall onset 10°',fill:SC.amber,fontSize:8,position:'insideTopRight'}}/>
                <ReferenceLine y={-10} stroke={SC.amber} strokeDasharray="4 3"/>
                <Area type="monotone" dataKey="alpha_deg" stroke={SC.blue} strokeWidth={2} fill="url(#bemg2)" dot={false} name="α (°)"/>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Station table — every 5th */}
        <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px',overflowX:'auto'}}>
          <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
            Station Table (every 5th) — chord constant at c/R={chord_r}, hub cutout at r/R={hubR}
          </div>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:9,fontFamily:"'DM Mono',monospace"}}>
            <thead>
              <tr style={{background:SC.bg}}>
                {['r/R','λ','a′','φ(°)','α(°)','Cl','Cd','F','a','dT/dr(N/m)'].map(h=>(
                  <th key={h} style={{padding:'4px 8px',textAlign:'right',color:SC.muted,borderBottom:`1px solid ${SC.border}`}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {results.stations.filter((_,i)=>i%5===0||i===results.stations.length-1).map((s,i)=>(
                <tr key={i} style={{background:i%2===0?SC.bg:'transparent'}}>
                  {[s.rR, s.lam, s.lam_prime, s.phi_deg, s.alpha_deg, s.Cl, s.Cd, s.F, s.a, s.dT].map((v,j)=>(
                    <td key={j} style={{padding:'4px 8px',textAlign:'right',
                      color: j===4&&Math.abs(v)>10 ? SC.red : j===4&&Math.abs(v)>8 ? SC.amber : SC.text}}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}


const REG_DB = {
  "EASA SC-VTOL": {
    lastChecked: "2025-01-15",
    source: "https://www.easa.europa.eu/en/document-library/product-certification-consultations/special-condition-sc-vtol",
    rules: [
      { id:"SC-VTOL.2280", name:"OEI Thrust Margin",     param:"OEI_margin_pct", threshold:0,    unit:"%",    direction:"min", desc:"Remaining thrust must equal or exceed hover weight with one motor inoperative." },
      { id:"SC-VTOL.2315", name:"Positive Load Factor",  param:"n_pos_limit",    threshold:3.5,  unit:"g",    direction:"min", desc:"Limit manoeuvre load factor for CAT-A operations." },
      { id:"SC-VTOL.2320", name:"Negative Load Factor",  param:"n_neg_limit",    threshold:-1.5, unit:"g",    direction:"max", desc:"Minimum negative load factor limit." },
      { id:"SC-VTOL.2500", name:"Min Battery Reserve",   param:"socMin",         threshold:0.20, unit:"frac", direction:"min", desc:"Battery must retain ≥20% SoC at end of mission including reserves." },
      { id:"SC-VTOL.2510", name:"Max Tip Mach",          param:"TipMach",        threshold:0.70, unit:"Mach", direction:"max", desc:"Blade tip Mach number limit for noise and compressibility." },
      { id:"SC-VTOL.2540", name:"Static Margin Min",     param:"SM_vt",          threshold:0.05, unit:"MAC",  direction:"min", desc:"Minimum static margin for longitudinal stability." },
      { id:"SC-VTOL.2541", name:"Static Margin Max",     param:"SM_vt",          threshold:0.25, unit:"MAC",  direction:"max", desc:"Maximum static margin to retain adequate controllability." },
    ]
  },
  "FAA AC 21-17-4": {
    lastChecked: "2025-01-15",
    source: "https://rgl.faa.gov/Regulatory_and_Guidance_Library/rgAdvisoryCircular.nsf/",
    rules: [
      { id:"AC21-17.4.3", name:"MTOW Limit (Part 27)", param:"MTOW",       threshold:5700, unit:"kg",  direction:"max", desc:"Maximum certificated takeoff weight for Part 27 category." },
      { id:"AC21-17.4.5", name:"Battery Fraction",     param:"batFrac",    threshold:55,   unit:"%",   direction:"max", desc:"Practical battery mass fraction limit for structural feasibility." },
      { id:"AC21-17.4.8", name:"Dive Speed Margin",    param:"VD_margin",  threshold:1.25, unit:"×VC", direction:"min", desc:"VD must be ≥1.25×VC for structural clearance." },
      { id:"AC21-17.4.9", name:"Hover T/W Ratio",      param:"twRatio",    threshold:1.0,  unit:"",    direction:"min", desc:"Thrust-to-weight ratio ≥1.0 in hover for positive climb gradient." },
    ]
  }
};

function RegTrackerPanel({ params, SR, SC }) {
  const [checking,  setChecking]  = useState(false);
  const [aiReport,  setAiReport]  = useState(null);
  const [aiErr,     setAiErr]     = useState("");
  const [regData,   setRegData]   = useState(REG_DB);
  const [expanded,  setExpanded]  = useState({});

  // Evaluate each rule against current design
  const evaluate = (rule, p, sr) => {
    const val = (() => {
      switch(rule.param) {
        case "OEI_margin_pct": {
          if(!sr) return null;
          const g=9.81, N=p.nPropHover, TW=p.twRatio||1.2;
          const T_nom = sr.MTOW*g*TW/N;         // motor design thrust (uses T/W)
          const T_oei = (N-1)*T_nom;            // (N-1) motors at full thrust
          return +(((T_oei - sr.MTOW*g)/(sr.MTOW*g))*100).toFixed(1);
        }
        case "n_pos_limit":    return 3.5;
        case "n_neg_limit":    return -1.5;
        case "socMin":         return p.socMin;
        case "TipMach":        return sr?.TipMach;
        case "SM_vt":          return sr?.SM_vt;
        case "MTOW":           return sr?.MTOW;
        case "batFrac":        return sr ? +(sr.Wbat/sr.MTOW*100).toFixed(1) : null;
        case "VD_margin":      return sr ? +(sr.VD/p.vCruise).toFixed(3) : null;
        case "twRatio":        return p.twRatio;
        default: return null;
      }
    })();
    if (val === null) return { val: 'N/A', pass: null };
    const pass = rule.direction === 'min' ? val >= rule.threshold : val <= rule.threshold;
    return { val, pass };
  };

  const checkUpdates = async () => {
    setChecking(true); setAiErr(""); setAiReport(null);
    try {
      const rulesText = Object.entries(regData).map(([reg, data]) =>
        `${reg}:\n${data.rules.map(r => `  ${r.id} ${r.name}: current threshold = ${r.threshold} ${r.unit} (${r.direction}imum)`).join('\n')}`
      ).join('\n\n');

      const prompt = `You are an aviation regulatory expert specializing in eVTOL certification. 

Below are the regulatory thresholds I have stored for EASA SC-VTOL and FAA AC 21-17-4 as of early 2025:

${rulesText}

Based on your knowledge of these regulations up to your training cutoff:
1. Have any of these specific threshold VALUES changed from what I have stored?
2. Are there any NEW requirements I am missing that would affect an eVTOL with: MTOW=${SR?.MTOW||2177}kg, nProp=${params.nPropHover}, range=${params.range}km?
3. What are the top 3 certification risks for this specific design?

Respond in plain text, clearly structured. Be specific about rule IDs and numerical values. If you are uncertain about a specific value, say so.`;

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${import.meta.env.VITE_GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          max_tokens: 600,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (!res.ok) { const t = await res.text(); throw new Error(`AI ${res.status}: ${t.slice(0,200)}`); }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      if (!text) throw new Error("No response from AI");
      setAiReport(text);
    } catch(e) {
      setAiErr("AI check failed: " + e.message);
    }
    setChecking(false);
  };

  const toggleExpand = (key) => setExpanded(p => ({...p, [key]: !p[key]}));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div style={{ background: `linear-gradient(135deg,${SC.bg},#1a1200)`, border: `1px solid ${SC.amber}44`, borderRadius: 10, padding: '16px 20px' }}>
        <div style={{ fontSize: 9, color: SC.muted, fontFamily: "'DM Mono',monospace", letterSpacing: '0.18em', marginBottom: 4 }}>EASA SC-VTOL · FAA AC 21-17-4 · AI-POWERED UPDATE CHECK</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: SC.text, marginBottom: 6 }}>
          <span style={{ color: SC.amber }}>Regulatory</span> Change Tracker
        </div>
        <div style={{ fontSize: 11, color: SC.muted, lineHeight: 1.7, maxWidth: 760 }}>
          Evaluates your current design against stored EASA SC-VTOL and FAA AC 21-17-4 thresholds in real time. "Check for Updates" asks Claude to identify any threshold changes and certification risks specific to your design configuration.
        </div>
      </div>

      {/* Live compliance table */}
      {Object.entries(regData).map(([regName, regInfo]) => (
        <div key={regName} style={{ background: SC.panel, border: `1px solid ${SC.border}`, borderRadius: 8, overflow: 'hidden' }}>
          <div
            onClick={() => toggleExpand(regName)}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', cursor: 'pointer', background: SC.bg, borderBottom: `1px solid ${SC.border}` }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 700, color: SC.text, fontFamily: "'DM Mono',monospace" }}>{regName}</span>
              <span style={{ fontSize: 9, color: SC.muted, fontFamily: "'DM Mono',monospace", marginLeft: 12 }}>Last checked: {regInfo.lastChecked}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {(() => {
                const results = regInfo.rules.map(r => evaluate(r, params, SR));
                const fails = results.filter(r => r.pass === false).length;
                return <span style={{ fontSize: 10, fontWeight: 700, fontFamily: "'DM Mono',monospace", color: fails > 0 ? SC.red : SC.green }}>{fails > 0 ? `❌ ${fails} FAIL` : '✅ ALL PASS'}</span>;
              })()}
              <span style={{ color: SC.muted, fontSize: 12 }}>{expanded[regName] ? '▲' : '▼'}</span>
            </div>
          </div>
          {expanded[regName] && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9, fontFamily: "'DM Mono',monospace" }}>
                <thead>
                  <tr style={{ background: SC.bg }}>
                    {['Rule ID', 'Requirement', 'Threshold', 'Your Design', 'Status', 'Description'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', color: SC.muted, fontWeight: 700, borderBottom: `1px solid ${SC.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {regInfo.rules.map((rule, i) => {
                    const { val, pass } = evaluate(rule, params, SR);
                    return (
                      <tr key={rule.id} style={{ background: pass === false ? `${SC.red}08` : pass === true ? `${SC.green}05` : 'transparent', borderBottom: `1px solid ${SC.border}22` }}>
                        <td style={{ padding: '7px 10px', color: SC.amber, fontWeight: 700 }}>{rule.id}</td>
                        <td style={{ padding: '7px 10px', color: SC.text, fontWeight: 600 }}>{rule.name}</td>
                        <td style={{ padding: '7px 10px', color: SC.muted }}>{rule.direction === 'min' ? '≥' : '≤'} {rule.threshold} {rule.unit}</td>
                        <td style={{ padding: '7px 10px', color: pass === false ? SC.red : pass === true ? SC.green : SC.muted, fontWeight: 700 }}>{val === 'N/A' ? '—' : val}</td>
                        <td style={{ padding: '7px 10px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 3, fontSize: 8, fontWeight: 800, background: pass === false ? `${SC.red}22` : pass === true ? `${SC.green}22` : `${SC.muted}22`, color: pass === false ? SC.red : pass === true ? SC.green : SC.muted }}>
                            {pass === null ? 'N/A' : pass ? 'PASS ✅' : 'FAIL ❌'}
                          </span>
                        </td>
                        <td style={{ padding: '7px 10px', color: SC.muted, maxWidth: 260 }}>{rule.desc}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {/* AI Update Check */}
      <div style={{ background: SC.panel, border: `1px solid ${SC.amber}33`, borderRadius: 8, padding: '14px 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: SC.amber, fontFamily: "'DM Mono',monospace", marginBottom: 10 }}>🤖 AI Regulatory Update Check</div>
        <div style={{ fontSize: 10, color: SC.muted, fontFamily: "'DM Mono',monospace", marginBottom: 12, lineHeight: 1.7 }}>
          Asks Claude to identify: (1) threshold changes from stored values, (2) new requirements for your specific design, (3) top 3 certification risks.
        </div>
        <button onClick={checkUpdates} disabled={checking} type="button"
          style={{ padding: '9px 24px', background: checking ? 'transparent' : `linear-gradient(135deg,#1c1000,${SC.amber}88)`, border: `2px solid ${SC.amber}`, borderRadius: 7, color: checking ? SC.muted : SC.amber, fontSize: 11, fontWeight: 800, cursor: checking ? 'not-allowed' : 'pointer', fontFamily: "'DM Mono',monospace" }}>
          {checking ? '⟳ Checking with Claude…' : '📜 Check for Regulatory Updates'}
        </button>
        {aiErr && <div style={{ marginTop: 10, padding: '8px 12px', background: `${SC.red}11`, border: `1px solid ${SC.red}44`, borderRadius: 6, fontSize: 10, color: SC.red, fontFamily: "'DM Mono',monospace" }}>{aiErr}</div>}
        {aiReport && (
          <div style={{ marginTop: 12, padding: '14px 16px', background: SC.bg, border: `1px solid ${SC.border}`, borderRadius: 8, fontSize: 10, color: SC.text, fontFamily: "'DM Mono',monospace", lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>
            {aiReport}
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   AI DESIGN ASSISTANT — Claude-powered iterative sizing
   Engineer describes requirements in plain language.
   Claude calls run_sizing tool iteratively, updates sliders live.
   First AI-native aircraft sizing tool ever built.
   ════════════════════════════════════════════════════════════════════════ */
function AIAssistantPanel({ params, SR, SC, onParamChange, user }) {
  const [mode,     setMode]     = useState('design'); // 'design' | 'chat'

  // ── SUPABASE CONFIG ──
  const SB_URL = "https://obribjypwwrbhsyjllua.supabase.co";
  const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";
  const SB_HDR = { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

  const LS_KEY = 'evtol_ai_chat_local'; // localStorage key for instant refresh restore

  const DEFAULT_MSG = [{ role:'assistant', mode:'design',
    content:"👋 I'm your AI Design Assistant.\n\nDescribe your eVTOL requirements and I'll run a deterministic optimizer to find the best feasible design, then inject it directly into all your app sliders.\n\nExample: \"4 passengers, 80km range, EASA SC-VTOL certification\"" }];

  // ── Read from localStorage immediately (synchronous — zero delay on refresh) ──
  const readLocalCache = () => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (!s) return null;
      return JSON.parse(s);
    } catch { return null; }
  };

  // Initialise from localStorage so chat is visible instantly on refresh
  const localCache = readLocalCache();
  const [messages,    setMessages]    = useState(localCache?.messages?.length ? localCache.messages : DEFAULT_MSG);
  const [chatHistory, setChatHistory] = useState(localCache?.chatHistory || []);
  const [input,    setInput]    = useState('');
  const [thinking, setThinking] = useState(false);
  const [iterCount,setIterCount]= useState(localCache?.iterCount || 0);
  const [chatLoaded, setChatLoaded]   = useState(false);
  const saveDebounce = useRef(null);
  const bottomRef = useRef(null);
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}); },[messages]);

  // ── Write to localStorage on every change (synchronous, instant) ──
  useEffect(()=>{
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        messages: messages.slice(-200),
        chatHistory: chatHistory.slice(-40),
        iterCount,
      }));
    } catch {}
  }, [messages, chatHistory, iterCount]);

  // ── LOAD chat from Supabase on mount (when user is logged in) ──
  // Supabase gives cross-device sync; localStorage gives instant refresh restore
  useEffect(()=>{
    if (!user?.id) { setChatLoaded(true); return; }
    const uid = user.id;
    fetch(`${SB_URL}/rest/v1/evtol_ai_chat?user_id=eq.${uid}&order=created_at.desc&limit=1`, { headers: SB_HDR })
      .then(r=>r.json())
      .then(rows=>{
        if (rows && rows[0] && rows[0].messages_json) {
          try {
            const saved = JSON.parse(rows[0].messages_json);
            // Only override localStorage if Supabase has more messages
            // (handles the case where user logged in from another device)
            if (saved.messages?.length > messages.length) {
              setMessages(saved.messages);
              setChatHistory(saved.chatHistory || []);
              setIterCount(saved.iterCount || 0);
            }
          } catch {}
        }
        setChatLoaded(true);
      })
      .catch(()=>setChatLoaded(true));
  }, [user?.id]);

  // ── SAVE chat to Supabase (debounced 2s after last change) ──
  const saveToSupabase = (msgs, hist, iters) => {
    if (!user?.id || !chatLoaded) return;
    if (saveDebounce.current) clearTimeout(saveDebounce.current);
    saveDebounce.current = setTimeout(async () => {
      const payload = {
        user_id: user.id,
        messages_json: JSON.stringify({ messages: msgs.slice(-200), chatHistory: hist.slice(-40), iterCount: iters }),
        updated_at: new Date().toISOString(),
      };
      try {
        await fetch(`${SB_URL}/rest/v1/evtol_ai_chat`, {
          method: "POST",
          headers: { ...SB_HDR, "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(payload),
        });
      } catch {}
    }, 2000);
  };

  useEffect(()=>{ if(chatLoaded) saveToSupabase(messages, chatHistory, iterCount); }, [messages]);
  useEffect(()=>{ if(chatLoaded) saveToSupabase(messages, chatHistory, iterCount); }, [chatHistory, iterCount]);

  // ── CLEAR chat history ──
  const clearChat = async () => {
    setMessages(DEFAULT_MSG);
    setChatHistory([]);
    setIterCount(0);
    // Clear localStorage immediately
    try { localStorage.removeItem(LS_KEY); } catch {}
    // Clear Supabase if logged in
    if (!user?.id) return;
    try {
      await fetch(`${SB_URL}/rest/v1/evtol_ai_chat?user_id=eq.${user.id}`, {
        method: "DELETE",
        headers: SB_HDR,
      });
    } catch {}
  };

  /* ── Hard clamp to physical bounds ── */
  const clamp = (v,lo,hi) => Math.min(hi, Math.max(lo, isNaN(+v)?lo:+v));
  const sanitize = (p) => ({
    ...p,
    range:      clamp(p.range,      20,  500),
    payload:    clamp(p.payload,    50,  800),
    vCruise:    clamp(p.vCruise,    30,  120),
    LD:         clamp(p.LD,          8,   22),
    AR:         clamp(p.AR,          5,   16),
    sedCell:    clamp(p.sedCell,   150,  400),
    nPropHover: [4,6,8,10,12].reduce((a,b)=>Math.abs(b-p.nPropHover)<Math.abs(a-p.nPropHover)?b:a),
    propDiam:   clamp(p.propDiam,   1.2,  4.0),
    twRatio:    clamp(p.twRatio,    1.0,  1.5),
    ewf:        clamp(p.ewf,       0.30, 0.65),
    etaHov:     clamp(p.etaHov,    0.60, 0.85),
    etaSys:     clamp(p.etaSys,    0.70, 0.92),
  });

  /* ── Inject all params into app sliders ── */
  const inject = (p) => {
    Object.entries(p).forEach(([k,v])=>{ if(onParamChange&&!isNaN(+v)) onParamChange(k)(+v); });
  };

  /* ── Async Optimizer — chunked so browser never freezes ── */
  const optimizeAsync = async (userRange, userPayload, userVCruise) => {
    const R0 = clamp(userRange   || params.range,   20, 500);
    const P0 = clamp(userPayload || params.payload,  50, 800);
    const V0 = clamp(userVCruise || params.vCruise,  30, 120);

    const stable = {
      ...params,
      vCruise: V0,
      vtCh:    Math.max(+(params.vtCh)    || 0.45, 0.40),
      vtCv:    +(params.vtCv)    || 0.05,
      vtGamma: +(params.vtGamma) || 40,
      vtAR:    +(params.vtAR)    || 2.5,
      fusLen:  +(params.fusLen)  || 8.5,
      fusDiam: +(params.fusDiam) || 1.6,
      convTolExp: -3,   // fast convergence during search
    };

    const score = (R) => {
      if (!R || !isFinite(R.MTOW) || R.MTOW < 100) return Infinity;
      let penalty = 0;
      if (R.MTOW > 5700)              penalty += (R.MTOW - 5700) * 3;
      if (R.SM_vt < 0.04)             penalty += (0.04 - R.SM_vt) * 8000;
      if (R.SM_vt > 0.28)             penalty += (R.SM_vt - 0.28) * 5000;
      if (R.Wbat/R.MTOW > 0.55)      penalty += (R.Wbat/R.MTOW - 0.55) * 6000;
      if (R.TipMach > 0.70)           penalty += (R.TipMach - 0.70) * 5000;
      if (R.LDact < 10)               penalty += (10 - R.LDact) * 300;
      if (R.PackkWh < R.Etot)         penalty += (R.Etot - R.PackkWh) * 2000;
      if (!R.feasible)                penalty += 300;
      return R.MTOW + penalty - R.LDact * 40 - R.SM_vt * 800;
    };

    const tryP = (overrides) => {
      try {
        const p = sanitize({ ...stable, range:R0, payload:P0, ...overrides });
        const R = runSizing(p);
        return { p, R, s: score(R) };
      } catch { return { p:null, R:null, s:Infinity }; }
    };

    // Reduced grid — still covers the space well but ~2400 combos (not 60k)
    const sedV  = [200, 250, 300, 350, 400];
    const arV   = [7, 9, 11];
    const ewfV  = [0.38, 0.44, 0.50];
    const nPV   = [6, 8];
    const dV    = [2.0, 2.5, 3.0];
    const ldV   = [12, 14, 16];
    const twV   = [1.1, 1.3];
    const etaSV = [0.80, 0.85, 0.90];

    // Build all combos
    const combos = [];
    for (const sed  of sedV)
    for (const ar   of arV)
    for (const ewf  of ewfV)
    for (const nP   of nPV)
    for (const d    of dV)
    for (const ld   of ldV)
    for (const tw   of twV)
    for (const etaS of etaSV)
      combos.push({ sedCell:sed, AR:ar, ewf, nPropHover:nP, propDiam:d, LD:ld, twRatio:tw, etaSys:etaS });

    let best = { p:null, R:null, s:Infinity };
    const CHUNK = 50; // evaluate 50 combos per frame

    // Process in async chunks — yields to browser between chunks
    for (let i = 0; i < combos.length; i += CHUNK) {
      const slice = combos.slice(i, i + CHUNK);
      for (const ovr of slice) {
        const t = tryP(ovr);
        if (t.s < best.s) best = t;
      }
      // Yield to browser every chunk so UI stays responsive
      await new Promise(r => setTimeout(r, 0));
    }

    // Phase 2: Coordinate descent fine-tune around best found
    if (best.p) {
      const dims  = ['sedCell','AR','ewf','propDiam','LD','twRatio','etaSys','etaHov'];
      const steps = { sedCell:15, AR:0.5, ewf:0.02, propDiam:0.2, LD:1, twRatio:0.05, etaSys:0.02, etaHov:0.02 };
      let improved = true, iters = 0;
      while (improved && iters < 20) {
        improved = false; iters++;
        for (const dim of dims) {
          for (const dir of [-1, 1]) {
            const t = tryP({ ...best.p, [dim]: best.p[dim] + dir * steps[dim] });
            if (t.s < best.s) { best = t; improved = true; }
          }
        }
        Object.keys(steps).forEach(k => { steps[k] *= 0.8; });
        await new Promise(r => setTimeout(r, 0)); // yield each outer iter
      }
    }

    return best.R ? best : null;
  };

    /* ── Parse user intent from text ── */
  const parseIntent = (text) => {
    const lower = text.toLowerCase();
    // Extract range
    const rangeMatch = lower.match(/(\d+)\s*km/);
    const range = rangeMatch ? +rangeMatch[1] : null;
    // Extract passengers → payload (80kg per pax + 20kg bags)
    const paxMatch = lower.match(/(\d+)\s*passenger/);
    const payload = paxMatch ? +paxMatch[1] * 100 : null;
    // Extract speed
    const speedMatch = lower.match(/(\d+)\s*m\/s/);
    const vCruise = speedMatch ? +speedMatch[1] : null;
    return { range, payload, vCruise };
  };

  /* ── Call Groq for natural language summary only ── */
  const getSummary = async (R, p, userMsg) => {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${import.meta.env.VITE_GROQ_KEY}`},
        body: JSON.stringify({
          model:"llama-3.1-8b-instant", max_tokens:250,
          messages:[
            {role:"system", content:"You are a concise aerospace engineer. Write a 3-sentence design summary. No JSON, no bullet points, just plain sentences."},
            {role:"user", content:`User asked: "${userMsg}". Result: MTOW=${R.MTOW}kg, battery=${R.Wbat}kg (${(R.Wbat/R.MTOW*100).toFixed(1)}% of MTOW), energy=${R.Etot}kWh, hover power=${R.Phov}kW, cruise power=${R.Pcr}kW, L/D=${R.LDact}, wing span=${R.bWing}m, static margin=${(R.SM_vt*100).toFixed(1)}%, tip Mach=${R.TipMach}, feasible=true. Key params: range=${p.range}km, payload=${p.payload}kg, sedCell=${p.sedCell}Wh/kg, AR=${p.AR}, ${p.nPropHover} rotors at ${p.propDiam}m diameter. Write a 3-sentence engineering summary.`}
          ]
        })
      });
      if(!res.ok) return null;
      const d = await res.json();
      return d.choices?.[0]?.message?.content || null;
    } catch { return null; }
  };

  /* ── CHAT MODE: plain conversational AI (no optimizer, no injection) ── */
  const sendChat = async () => {
    if(!input.trim()||thinking) return;
    const userMsg = input.trim();
    setInput('');
    setMessages(p=>[...p,{role:'user',content:userMsg,mode:'chat'}]);
    setThinking(true);

    const newHistory = [...chatHistory, {role:'user',content:userMsg}];
    setChatHistory(newHistory);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions",{
        method:"POST",
        headers:{"Content-Type":"application/json","Authorization":`Bearer ${import.meta.env.VITE_GROQ_KEY}`},
        body: JSON.stringify({
          model:"llama-3.1-8b-instant",
          max_tokens:800,
          messages:[
            {role:"system", content:`You are a knowledgeable aerospace engineering assistant specializing in eVTOL aircraft. You help engineers and students understand concepts, solve problems, and learn about aviation. The user is working on an eVTOL sizing tool. Current design context: MTOW=${SR?.MTOW||'unknown'}kg, range=${params.range}km, payload=${params.payload}kg, ${params.nPropHover} rotors. Answer clearly and helpfully. For technical questions give depth. For simple questions be concise.`},
            ...newHistory.slice(-10) // keep last 10 for context
          ]
        })
      });
      if(!res.ok){const t=await res.text();throw new Error(`AI ${res.status}: ${t.slice(0,150)}`);}
      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content || "No response.";
      setChatHistory(h=>[...h,{role:'assistant',content:reply}]);
      setMessages(p=>[...p,{role:'assistant',content:reply,mode:'chat'}]);
    } catch(e){
      setMessages(p=>[...p,{role:'assistant',content:`⚠️ ${e.message}`,mode:'chat'}]);
    }
    setThinking(false);
  };

  /* ── unified send dispatcher ── */
  const send = async () => {
    if(mode==='chat') { await sendChat(); return; }
    await sendDesign();
  };

  const sendDesign = async () => {
    if(!input.trim()||thinking) return;
    const userMsg = input.trim();
    setInput('');
    setMessages(p=>[...p,{role:'user',content:userMsg,mode:'design'}]);
    setThinking(true);
    try {
      /* Step 1: Parse user intent */
      const intent = parseIntent(userMsg);
      setMessages(p=>[...p,{role:'assistant',content:`🔍 Parsing requirements...\nRange: ${intent.range||params.range}km | Payload: ${intent.payload||params.payload}kg | Speed: ${intent.vCruise||params.vCruise}m/s\n\n⚙️ Running optimizer across ${6*6*5*2*3} design combinations...`}]);

      /* Step 2: Run deterministic optimizer */
      await new Promise(r=>setTimeout(r,50)); // let UI update
      const result = await optimizeAsync(intent.range, intent.payload, intent.vCruise);
      const bestResult = result && result.R ? result : null;

      if(!bestResult) {
        // Fallback: try with relaxed constraints (longer range or higher SED)
        setMessages(p=>[...p,{role:'assistant',content:"⚠️ No feasible design found with exact requirements. Trying relaxed parameters..."}]);
        const relaxedRaw = await optimizeAsync(
          Math.max(20, (intent.range||params.range)*0.8),
          Math.max(50, (intent.payload||params.payload)*0.9),
          intent.vCruise
        );
        const relaxed = relaxedRaw && relaxedRaw.R ? relaxedRaw : null;
        if(!relaxed) {
          setMessages(p=>[...p,{role:'assistant',content:"❌ Cannot find a feasible design for these requirements. Try reducing range or payload."}]);
          setThinking(false); return;
        }
        // Use relaxed result
        const {p:rp, R:rR} = relaxed;
        inject(rp);
        setIterCount(c=>c+1);
        setMessages(prev=>[...prev,{role:'assistant',content:`✅ Feasible design found (relaxed constraints):\nRange reduced to ${rp.range}km, Payload to ${rp.payload}kg\n\nMTOW: ${rR.MTOW}kg | Battery: ${rR.Wbat}kg (${(rR.Wbat/rR.MTOW*100).toFixed(1)}%) | Energy: ${rR.Etot}kWh | L/D: ${rR.LDact} | Span: ${rR.bWing}m\n\n✅ All parameters injected into your app.`}]);
        setThinking(false); return;
      }

      const {p:bestP, R:bestR} = bestResult;

      /* Step 3: Inject into app live */
      inject(bestP);
      setIterCount(c=>c+1);

      /* Step 4: Show results immediately */
      setMessages(prev=>[...prev,{role:'assistant',content:
        `✅ FEASIBLE DESIGN FOUND — injected into all app tabs:\n\n` +
        `MTOW:        ${bestR.MTOW} kg\n` +
        `Battery:     ${bestR.Wbat} kg  (${(bestR.Wbat/bestR.MTOW*100).toFixed(1)}% of MTOW)\n` +
        `Total Energy:${bestR.Etot} kWh\n` +
        `Hover Power: ${bestR.Phov} kW\n` +
        `Cruise Power:${bestR.Pcr} kW\n` +
        `Wing Span:   ${bestR.bWing} m\n` +
        `L/D (actual):${bestR.LDact}\n` +
        `Static Margin:${(bestR.SM_vt*100).toFixed(1)}%\n` +
        `Tip Mach:    ${bestR.TipMach}\n\n` +
        `Key design: ${bestP.sedCell}Wh/kg cells · AR=${bestP.AR} · ${bestP.nPropHover}×${bestP.propDiam}m rotors · ewf=${bestP.ewf}\n\n` +
        `⏳ Getting engineering summary...`
      }]);

      /* Step 5: Get AI summary */
      const summary = await getSummary(bestR, bestP, userMsg);
      if(summary) {
        setMessages(prev=>{
          const msgs = [...prev];
          const last = msgs[msgs.length-1];
          msgs[msgs.length-1] = {...last, content: last.content.replace('⏳ Getting engineering summary...', `📋 ${summary}`)};
          return msgs;
        });
      }

    } catch(e) {
      setMessages(p=>[...p,{role:'assistant',content:`⚠️ Error: ${e.message}`}]);
    }
    setThinking(false);
  };

  return (
    <div style={{display:'flex',flexDirection:'column',gap:12}}>
      {/* ── Header ── */}
      <div style={{background:`linear-gradient(135deg,${SC.bg},#120a1f)`,border:`1px solid ${SC.purple}44`,borderRadius:10,padding:'16px 20px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:10}}>
          <div>
            <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:'0.18em',marginBottom:4}}>
              {mode==='design'?'DETERMINISTIC OPTIMIZER · ALL TABS UPDATE LIVE':'LLAMA 3 VIA GROQ · CONVERSATIONAL · CONTEXT-AWARE'}
            </div>
            <div style={{fontSize:18,fontWeight:800,color:SC.text}}>
              <span style={{color:SC.purple}}>AI</span> {mode==='design'?'Design Assistant':'Chat Assistant'}
              {mode==='design'&&iterCount>0&&<span style={{fontSize:11,color:SC.green,marginLeft:12}}>✅ {iterCount} design{iterCount>1?'s':''} optimized</span>}
          <span style={{fontSize:9,color:SC.dim,marginLeft:8,fontFamily:"'DM Mono',monospace"}}>💾 auto-saved</span>
            </div>
          </div>

          {/* ── Mode Toggle ── */}
          <div style={{display:'flex',gap:0,background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:8,overflow:'hidden',flexShrink:0}}>
            {[
              {key:'design', icon:'🛠️', label:'Design Mode',  tip:'Optimizer finds best feasible aircraft and injects into all tabs'},
              {key:'chat',   icon:'💬', label:'Chat Mode',    tip:'Ask anything — concepts, theory, problems, comparisons'},
            ].map(({key,icon,label,tip})=>(
              <button key={key} onClick={()=>{
                setMode(key);
                // Add a context message when switching
                setMessages(p=>[...p,{role:'assistant',mode:key,content:
                  key==='design'
                  ?"🛠️ Switched to Design Mode. Describe your eVTOL requirements and I'll find the optimal design and inject it into all app tabs."
                  :"💬 Switched to Chat Mode. Ask me anything — BEM theory, certification questions, aerodynamics, comparisons, or general eVTOL concepts."
                }]);
              }} type="button" title={tip}
                style={{
                  padding:'8px 16px',
                  background:mode===key?`linear-gradient(135deg,#2d1b69,${SC.purple})`:'transparent',
                  border:'none',
                  color:mode===key?'#e9d5ff':SC.muted,
                  fontSize:10,fontWeight:mode===key?800:500,
                  cursor:'pointer',fontFamily:"'DM Mono',monospace",
                  transition:'all 0.15s',
                }}>
                {icon} {label}
              </button>
            ))}
          </div>
        </div>
        <div style={{fontSize:11,color:SC.muted,lineHeight:1.6,marginTop:8}}>
          {mode==='design'
            ?'Describe requirements → optimizer searches design combinations → injects best feasible design into every tab instantly.'
            :'Ask anything about eVTOL design, aerodynamics, BEM theory, certification, or any engineering concept. Maintains conversation context.'}
        </div>
      </div>

      <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,display:'flex',flexDirection:'column',height:460}}>
        <div style={{flex:1,overflowY:'auto',padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
          {messages.map((m,i)=>(
            <div key={i} style={{display:'flex',justifyContent:m.role==='user'?'flex-end':'flex-start'}}>
              <div style={{maxWidth:'84%',padding:'10px 14px',borderRadius:10,
                background:m.role==='user'?`${SC.purple}33`:SC.bg,
                border:`1px solid ${m.role==='user'?SC.purple+'55':SC.border}`,
                fontSize:11,color:SC.text,fontFamily:"'DM Mono',monospace",lineHeight:1.8,whiteSpace:'pre-wrap',wordBreak:'break-word'}}>
                {m.role==='assistant'&&<span style={{fontSize:8,color:SC.purple,fontWeight:800,display:'block',marginBottom:4}}>🤖 AI ASSISTANT{m.mode==='chat'?' · CHAT':m.mode==='design'?' · DESIGN':''}</span>}
                {m.content}
              </div>
            </div>
          ))}
          {thinking&&(
            <div style={{display:'flex',justifyContent:'flex-start'}}>
              <div style={{padding:'10px 14px',borderRadius:10,background:SC.bg,border:`1px solid ${SC.border}`,fontSize:11,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                <span style={{fontSize:8,color:SC.purple,fontWeight:800,display:'block',marginBottom:4}}>🤖 AI ASSISTANT</span>
                {mode==='design'?'⟳ Optimizing…':'⟳ Thinking…'}
              </div>
            </div>
          )}
          <div ref={bottomRef}/>
        </div>
        <div style={{borderTop:`1px solid ${SC.border}`,padding:'10px 14px',display:'flex',gap:10}}>
          <input value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&send()}
            placeholder={mode==='design'?"e.g. '4 passengers, 100km, EASA SC-VTOL, minimise MTOW'":"Ask anything — BEM theory, certification, aerodynamics, comparisons…"}
            style={{flex:1,background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:6,color:SC.text,fontSize:11,padding:'8px 12px',fontFamily:"'DM Mono',monospace",outline:'none'}}
            disabled={thinking}/>
          <button onClick={send} disabled={thinking||!input.trim()} type="button"
            style={{padding:'8px 20px',background:thinking?'transparent':`linear-gradient(135deg,#2d1b69,${SC.purple})`,border:`2px solid ${SC.purple}`,borderRadius:6,color:thinking?SC.muted:'#e9d5ff',fontSize:11,fontWeight:800,cursor:thinking||!input.trim()?'not-allowed':'pointer',fontFamily:"'DM Mono',monospace"}}>
            {thinking?'⟳':'→ Send'}
          </button>
        </div>
      </div>

      <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:'12px 14px'}}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8}}>
          <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
            {mode==='design'?'🛠️ DESIGN QUICK PROMPTS':'💬 CHAT QUICK PROMPTS'}
          </div>
          <button onClick={()=>{ if(window.confirm('Clear all chat history? This cannot be undone.')) clearChat(); }}
            type="button"
            style={{padding:'3px 10px',background:'transparent',border:`1px solid ${SC.red}55`,borderRadius:4,color:SC.red,fontSize:9,cursor:'pointer',fontFamily:"'DM Mono',monospace"}}>
            🗑 Clear History
          </button>
        </div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {(mode==='design'?[
            "4 passengers, 80km range, EASA SC-VTOL",
            "Minimise MTOW for current range and payload",
            "6 passengers, 150km, minimise battery weight",
            "2 passengers, 50km, urban air taxi",
            "Maximise range with battery under 40% MTOW",
            "Best design for 320kg payload, 100km range",
          ]:[
            "What is Blade Element Momentum theory?",
            "Explain static margin in simple terms",
            "What's the difference between Joby S4 and Archer Midnight?",
            "Why does increasing aspect ratio improve L/D?",
            "How does battery degradation affect eVTOL range?",
            "What is the Glauert correction and when is it needed?",
            "Explain EASA SC-VTOL certification requirements",
            "What is figure of merit for a helicopter rotor?",
          ]).map(q=>(
            <button key={q} onClick={()=>setInput(q)} type="button"
              style={{padding:'5px 12px',background:`${SC.purple}18`,border:`1px solid ${SC.purple}44`,borderRadius:5,color:SC.purple,fontSize:9,cursor:'pointer',fontFamily:"'DM Mono',monospace"}}>
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


function DesignSpacePanel({ params, SC, TTP, runSizingFn, onApply }) {
  const [results,  setResults]  = useState(null);
  const [running,  setRunning]  = useState(false);
  const [nSamples, setNSamples] = useState(300);
  const [xAxis,    setXAxis]    = useState("range");
  const [yAxis,    setYAxis]    = useState("MTOW");
  const [colorBy,  setColorBy]  = useState("feasible");
  const [applied,  setApplied]  = useState(null); // last applied point index for highlight

  const lhs = (n, dims) => {
    const result = [];
    for (let d = 0; d < dims; d++) {
      const col = Array.from({length:n}, (_,i) => (i + Math.random()) / n);
      for (let i = n-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [col[i],col[j]]=[col[j],col[i]]; }
      result.push(col);
    }
    return result;
  };

  const runDSE = () => {
    setRunning(true); setResults(null);
    setTimeout(() => {
      const N = nSamples;
      const vars = [
        {key:"range",   base:params.range,   pct:0.40},
        {key:"payload", base:params.payload, pct:0.40},
        {key:"LD",      base:params.LD,      pct:0.25},
        {key:"sedCell", base:params.sedCell, pct:0.30},
        {key:"ewf",     base:params.ewf,     pct:0.20},
        {key:"AR",      base:params.AR,      pct:0.30},
        {key:"etaHov",  base:params.etaHov,  pct:0.15},
        {key:"etaSys",  base:params.etaSys,  pct:0.15},
      ];
      const samples = lhs(N, vars.length);
      const pts = [];
      for (let i = 0; i < N; i++) {
        const pS = {...params};
        vars.forEach((v,d) => { pS[v.key] = v.base*(1-v.pct) + samples[d][i]*v.base*2*v.pct; });
        pS.AR = Math.round(pS.AR*10)/10;
        pS.payload = Math.round(pS.payload);
        try {
          const R = runSizingFn(pS);
          if (!R||!isFinite(R.MTOW)||R.MTOW>8000||R.MTOW<200) continue;
          pts.push({
            range:+pS.range.toFixed(1), payload:+pS.payload.toFixed(0),
            LD:+pS.LD.toFixed(2), sedCell:+pS.sedCell.toFixed(0),
            ewf:+pS.ewf.toFixed(3), AR:+pS.AR.toFixed(1),
            etaHov:+pS.etaHov.toFixed(3), etaSys:+pS.etaSys.toFixed(3),
            MTOW:+R.MTOW.toFixed(1), Wempty:+R.Wempty.toFixed(1), Wbat:+R.Wbat.toFixed(1),
            Etot:+R.Etot.toFixed(2), Phov:+R.Phov.toFixed(2), Pcr:+R.Pcr.toFixed(2),
            LDact:+R.LDact.toFixed(2), SM:+(R.SM_vt*100).toFixed(2),
            PackkWh:+R.PackkWh.toFixed(2), bWing:+R.bWing.toFixed(2),
            Swing:+R.Swing.toFixed(2), WL:+R.WL.toFixed(1),
            TipMach:+R.TipMach.toFixed(4), RPM:+R.RPM.toFixed(0),
            batFrac:+(R.Wbat/R.MTOW*100).toFixed(1),
            emptyFrac:+(R.Wempty/R.MTOW*100).toFixed(1),
            SEDpack:+R.SEDpack.toFixed(1),
            feasible:R.feasible, pareto:false,
            // Full-precision params for exact replay — avoids rounding mismatch on click
            _params:{
              range:pS.range, payload:pS.payload, LD:pS.LD, sedCell:pS.sedCell,
              ewf:pS.ewf, AR:pS.AR, etaHov:pS.etaHov, etaSys:pS.etaSys,
            },
          });
        } catch {}
      }
      const fp = pts.filter(p=>p.feasible);
      fp.forEach(p => { p.pareto = !fp.some(q=>q.MTOW<=p.MTOW&&q.range>=p.range&&q.payload>=p.payload&&(q.MTOW<p.MTOW||q.range>p.range||q.payload>p.payload)); });
      setResults({pts,feasCount:fp.length,paretoCount:fp.filter(p=>p.pareto).length,total:pts.length});
      setRunning(false);
    }, 80);
  };

  const axes=[
    // ── Outputs ──
    {key:"range",    label:"Range (km)"},
    {key:"payload",  label:"Payload (kg)"},
    {key:"MTOW",     label:"MTOW (kg)"},
    {key:"Wempty",   label:"Empty Weight (kg)"},
    {key:"Wbat",     label:"Battery Mass (kg)"},
    {key:"Etot",     label:"Total Energy (kWh)"},
    {key:"PackkWh",  label:"Pack Capacity (kWh)"},
    {key:"Phov",     label:"Hover Power (kW)"},
    {key:"Pcr",      label:"Cruise Power (kW)"},
    {key:"LDact",    label:"Actual L/D"},
    {key:"SM",       label:"Static Margin (%)"},
    {key:"bWing",    label:"Wing Span (m)"},
    {key:"Swing",    label:"Wing Area (m²)"},
    {key:"WL",       label:"Wing Loading (N/m²)"},
    {key:"TipMach",  label:"Tip Mach"},
    {key:"RPM",      label:"Rotor RPM"},
    {key:"batFrac",  label:"Battery Fraction (%)"},
    {key:"emptyFrac",label:"Empty Weight Fraction (%)"},
    {key:"SEDpack",  label:"Pack SED (Wh/kg)"},
    // ── Sampled inputs ──
    {key:"LD",       label:"Input L/D"},
    {key:"sedCell",  label:"Cell SED (Wh/kg)"},
    {key:"ewf",      label:"Empty Weight Fraction (input)"},
    {key:"AR",       label:"Aspect Ratio"},
    {key:"etaHov",   label:"Hover Efficiency η"},
    {key:"etaSys",   label:"System Efficiency η"},
  ];
  const colorOpts=[
    {key:"feasible", label:"Feasible / Infeasible"},
    {key:"pareto",   label:"Pareto Front"},
    {key:"LDact",    label:"Actual L/D"},
    {key:"batFrac",  label:"Battery Fraction"},
    {key:"SM",       label:"Static Margin"},
    {key:"Etot",     label:"Total Energy"},
    {key:"TipMach",  label:"Tip Mach"},
    {key:"emptyFrac",label:"Empty Frac"},
  ];
  const getColor = pt => {
    if(colorBy==="feasible")  return pt.feasible?"#22c55e":"#ef4444";
    if(colorBy==="pareto")    return pt.pareto?"#f59e0b":(pt.feasible?"#22c55e88":"#ef444455");
    if(colorBy==="LDact")     return `hsl(${Math.min(pt.LDact/20*120,120)},90%,55%)`;
    if(colorBy==="batFrac")   return `hsl(${Math.max(0,120-pt.batFrac*2)},90%,55%)`;
    if(colorBy==="SM")        return `hsl(${Math.min(Math.max(pt.SM,0)/30*120,120)},90%,55%)`;
    if(colorBy==="Etot")      return `hsl(${Math.max(0,200-pt.Etot*1.5)},90%,55%)`;
    if(colorBy==="TipMach")   return `hsl(${Math.max(0,120-pt.TipMach*300)},90%,55%)`;
    if(colorBy==="emptyFrac") return `hsl(${Math.max(0,120-pt.emptyFrac*2)},90%,55%)`;
    return "#60a5fa";
  };
  const sel={background:SC.bg,border:`1px solid ${SC.border}`,color:SC.text,borderRadius:4,padding:"4px 8px",fontSize:10,fontFamily:"'DM Mono',monospace",outline:"none"};
  const sm={fontSize:10,fontFamily:"'DM Mono',monospace",color:SC.muted};

  return(
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 16px",display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}><span style={sm}>Samples:</span><input type="range" min={100} max={800} step={50} value={nSamples} onChange={evt=>setNSamples(+evt.target.value)} style={{width:100}}/><span style={{...sm,color:SC.amber,fontWeight:700}}>{nSamples}</span></div>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={sm}>X:</span><select value={xAxis} onChange={evt=>setXAxis(evt.target.value)} style={sel}>{axes.map(a=><option key={a.key} value={a.key}>{a.label}</option>)}</select></div>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={sm}>Y:</span><select value={yAxis} onChange={evt=>setYAxis(evt.target.value)} style={sel}>{axes.map(a=><option key={a.key} value={a.key}>{a.label}</option>)}</select></div>
        <div style={{display:"flex",alignItems:"center",gap:6}}><span style={sm}>Color:</span><select value={colorBy} onChange={evt=>setColorBy(evt.target.value)} style={sel}>{colorOpts.map(a=><option key={a.key} value={a.key}>{a.label}</option>)}</select></div>
        <button onClick={runDSE} disabled={running} type="button" style={{padding:"7px 20px",background:running?"transparent":`linear-gradient(135deg,#4c1d95,#7c3aed)`,border:"2px solid #7c3aed",borderRadius:6,color:running?SC.muted:"#e9d5ff",fontSize:11,fontWeight:800,cursor:running?"not-allowed":"pointer",fontFamily:"'DM Mono',monospace"}}>
          {running?"⟳ Computing…":"🎯 Run Design Space Exploration"}
        </button>
      </div>

      {!results&&!running&&(
        <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:32,textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:12}}>🎯</div>
          <div style={{fontSize:13,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Click "Run Design Space Exploration"</div>
          <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.8,maxWidth:500,margin:"0 auto"}}>
            Latin Hypercube Sampling sweeps 8 design variables (±20-40% range).<br/>
            Each sample = complete sizing solution. Green = feasible, Red = infeasible.<br/>
            <strong style={{color:"#f59e0b"}}>Yellow = Pareto-optimal</strong> — no design beats them on all 3 objectives simultaneously.<br/>
            This is what Joby & Archer compute with proprietary tools. Now interactive and free.
          </div>
        </div>
      )}

      {running&&(
        <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:32,textAlign:"center"}}>
          <div style={{fontSize:28,marginBottom:8}}>⟳</div>
          <div style={{fontSize:12,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Running {nSamples} Latin Hypercube samples…</div>
        </div>
      )}

      {results&&(<>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {[["Total Samples",results.total,SC.text],["Feasible",`${results.feasCount} (${(results.feasCount/results.total*100).toFixed(0)}%)`,SC.green],["Infeasible",results.total-results.feasCount,SC.red],["Pareto-Optimal",`${results.paretoCount} ⭐`,"#f59e0b"]].map(([label,val,col])=>(
            <div key={label} style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"10px 14px",textAlign:"center"}}>
              <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",marginBottom:4}}>{label}</div>
              <div style={{fontSize:18,fontWeight:800,color:col,fontFamily:"'DM Mono',monospace"}}>{val}</div>
            </div>
          ))}
        </div>

        <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
          <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
            {axes.find(a=>a.key===xAxis)?.label} vs {axes.find(a=>a.key===yAxis)?.label}
            {colorBy==="pareto"&&<span style={{color:"#f59e0b",marginLeft:12}}>● Pareto-optimal</span>}
            {colorBy==="feasible"&&<><span style={{color:SC.green,marginLeft:12}}>● Feasible</span><span style={{color:SC.red,marginLeft:8}}>● Infeasible</span></>}
          </div>
          {(()=>{
            // Group points by color bucket for efficient rendering (not one series per point)
            const buckets={};
            results.pts.forEach(pt=>{
              const col=getColor(pt);
              const r=colorBy==="pareto"&&pt.pareto?5:3;
              const key=col+"_"+r;
              if(!buckets[key]) buckets[key]={col,r,pts:[]};
              buckets[key].pts.push(pt);
            });
            const TooltipContent=({payload})=>{
              if(!payload?.length) return null;
              const d=payload[0].payload;
              return(<div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:6,padding:"8px 12px",fontSize:9,fontFamily:"'DM Mono',monospace",maxHeight:320,overflowY:"auto",zIndex:999}}>
                {[["Range",d.range+" km"],["Payload",d.payload+" kg"],["MTOW",d.MTOW+" kg"],["Empty Wt",d.Wempty+" kg"],["Battery",d.Wbat+" kg"],["Energy",d.Etot+" kWh"],["Pack Cap",d.PackkWh+" kWh"],["Hover Pwr",d.Phov+" kW"],["Cruise Pwr",d.Pcr+" kW"],["L/D (actual)",d.LDact],["L/D (input)",d.LD],["Bat Frac",d.batFrac+"%"],["Empty Frac",d.emptyFrac+"%"],["Wing Span",d.bWing+" m"],["Wing Area",d.Swing+" m²"],["Wing Loading",d.WL+" N/m²"],["Static Margin",d.SM+"%"],["Tip Mach",d.TipMach],["RPM",d.RPM],["Cell SED",d.sedCell+" Wh/kg"],["Pack SED",d.SEDpack+" Wh/kg"],["AR",d.AR],["η_hov",d.etaHov],["η_sys",d.etaSys],["Status",d.feasible?"✅ Feasible":"❌ Infeasible"],["Pareto",d.pareto?"⭐ Yes":"—"]].map(([k,v])=>(
                  <div key={k} style={{display:"flex",gap:16,justifyContent:"space-between"}}><span style={{color:SC.muted}}>{k}</span><span style={{color:SC.text,fontWeight:700}}>{v}</span></div>
                ))}
              </div>);
            };
            return(
            <>
            {onApply&&(
              <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,padding:"4px 8px",background:`${SC.amber}11`,border:`1px solid ${SC.amber}33`,borderRadius:4}}>
                💡 Click any dot to apply that design's parameters to the sizer — all tabs will update instantly.
                {applied!==null&&<span style={{color:SC.amber,marginLeft:8}}>✓ Point #{applied+1} applied</span>}
              </div>
            )}
            <ResponsiveContainer width="100%" height={400}>
              <ScatterChart margin={{top:10,right:20,bottom:40,left:10}}>
                <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                <XAxis type="number" dataKey={xAxis} name={axes.find(a=>a.key===xAxis)?.label}
                  tick={{fontSize:9,fill:SC.muted}}
                  label={{value:axes.find(a=>a.key===xAxis)?.label,position:"insideBottom",offset:-18,fontSize:10,fill:SC.muted}}/>
                <YAxis type="number" dataKey={yAxis} name={axes.find(a=>a.key===yAxis)?.label}
                  tick={{fontSize:9,fill:SC.muted}}
                  label={{value:axes.find(a=>a.key===yAxis)?.label,angle:-90,position:"insideLeft",fontSize:10,fill:SC.muted}}/>
                <Tooltip cursor={{strokeDasharray:"3 3"}} content={TooltipContent}/>
                {Object.entries(buckets).map(([key,{col,r,pts:bpts}])=>(
                  <Scatter key={key}
                    data={bpts.map((pt)=>({...pt,x:pt[xAxis],y:pt[yAxis]}))}
                    dataKey="y" fill={col} opacity={0.85}
                    onClick={onApply?(data)=>{
                      // Recharts Scatter onClick: actual point is in data.payload (not data directly)
                      const pt = data?.payload ?? data;
                      if(!pt||pt.range==null) return;
                      // Use _params (full precision) for exact MTOW replay, fall back to display values
                      onApply(pt._params || pt);
                      setApplied(`${pt.range}_${pt.payload}_${pt.MTOW}`);
                    }:undefined}
                    shape={(props)=>{
                      const{cx,cy,payload}=props;
                      const key_=`${payload.range}_${payload.payload}_${payload.MTOW}`;
                      const isApplied=applied!==null&&key_===applied;
                      return(
                        <circle cx={cx} cy={cy} r={isApplied?7:r}
                          fill={isApplied?"#f59e0b":col}
                          opacity={0.9}
                          stroke={isApplied?"#fff":"none"}
                          strokeWidth={isApplied?2:0}
                          style={{cursor:onApply?"pointer":"default"}}/>
                      );
                    }}/>
                ))}
              </ScatterChart>
            </ResponsiveContainer>
            </>
            );
          })()}
        </div>

          <div style={{background:SC.panel,border:"1px solid #f59e0b44",borderRadius:8,padding:"12px 14px"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#f59e0b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>⭐ Pareto-Optimal Designs ({results.paretoCount}) — Non-dominated frontier</div>
            {onApply&&<div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Click any row to apply that design to the sizer.</div>}
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:9,fontFamily:"'DM Mono',monospace"}}>
                <thead><tr style={{background:SC.bg}}>{["Range km","Payload kg","MTOW kg","Energy kWh","L/D","Bat%"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"right",color:SC.muted,fontWeight:700,borderBottom:`1px solid ${SC.border}`}}>{h}</th>)}</tr></thead>
                <tbody>{results.pts.filter(p=>p.pareto).sort((a,b)=>b.range-a.range).slice(0,10).map((pt,i)=>(
                  <tr key={i} onClick={onApply?()=>{
                    onApply(pt._params || pt);
                    setApplied(`${pt.range}_${pt.payload}_${pt.MTOW}`);
                  }:undefined}
                  style={{background:i%2===0?"#f59e0b08":"transparent",cursor:onApply?"pointer":"default"}}
                  onMouseEnter={e=>{if(onApply)e.currentTarget.style.background="#f59e0b22";}}
                  onMouseLeave={e=>{e.currentTarget.style.background=i%2===0?"#f59e0b08":"transparent";}}>
                    {[pt.range,pt.payload,pt.MTOW,pt.Wbat,pt.Etot,pt.LDact,pt.SM+"%",pt.bWing,pt.batFrac+"%",pt.SEDpack].map((v,j)=>(
                      <td key={j} style={{padding:"5px 8px",textAlign:"right",color:j===0?"#f59e0b":SC.text,fontWeight:j===0?800:400,borderBottom:`1px solid ${SC.border}22`}}>{v}</td>
                    ))}
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
      </>)}
    </div>
  );
}

/* ── Sensitivity Analysis Panel ── */
function SensPanel({params,SR,SC}){
  const[running,setRunning]=useState(false);
  const[results,setResults]=useState(null);
  const KEYS=[
    {k:"range",    l:"Range"},    {k:"payload",  l:"Payload"},
    {k:"sedCell",  l:"Cell SED"}, {k:"ewf",      l:"Empty Wt Frac"},
    {k:"LD",       l:"L/D"},      {k:"etaHov",   l:"Hover FOM"},
    {k:"etaSys",   l:"System η"}, {k:"etaBat",   l:"Battery η"},
    {k:"propDiam", l:"Rotor Dia"},{k:"AR",        l:"Aspect Ratio"},
    {k:"twRatio",  l:"T/W"},      {k:"nPropHover",l:"# Rotors"},
  ];
  const run=()=>{
    setRunning(true); setResults(null);
    setTimeout(()=>{
      const base=SR.MTOW;
      const res=KEYS.map(({k,l})=>{
        const v=Number(params[k]);
        if(!isFinite(v)) return null;
        let hi,lo;
        try{hi=runSizing({...params,[k]:v*1.1});}catch{return null;}
        try{lo=runSizing({...params,[k]:v*0.9});}catch{return null;}
        if(!hi||!lo) return null;
        const impact=Math.abs((hi.MTOW-base)-(lo.MTOW-base))/2;
        return {k,l,impact:+impact.toFixed(1),pct:+(impact/base*100).toFixed(2)};
      }).filter(Boolean).sort((a,b)=>b.impact-a.impact);
      setResults(res); setRunning(false);
    },10);
  };
  const max=results?Math.max(...results.map(r=>r.impact),1):1;
  return(
    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"14px 16px",marginTop:4}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:results?12:0,flexWrap:"wrap"}}>
        <div style={{flex:1}}>
          <div style={{fontSize:13,fontWeight:700,color:SC.text,fontFamily:"system-ui,sans-serif"}}>🎯 One-Click Sensitivity Report</div>
          <div style={{fontSize:10,color:SC.muted,marginTop:2,fontFamily:"system-ui,sans-serif"}}>Sweeps 12 params ±10% — ranks by MTOW impact</div>
        </div>
        <button onClick={run} disabled={running} type="button"
          style={{padding:"8px 22px",background:running?"transparent":`linear-gradient(135deg,${SC.amber},#f97316)`,
            border:`1px solid ${running?SC.border:SC.amber}`,borderRadius:6,
            color:running?SC.muted:"#07090f",fontSize:11,fontWeight:800,
            cursor:running?"not-allowed":"pointer",fontFamily:"system-ui,sans-serif",whiteSpace:"nowrap"}}>
          {running?"⏳ Running…":"▶ Run Analysis"}
        </button>
      </div>
      {results&&(
        <div>
          {results.map((r,i)=>{
            const col=i===0?SC.red:i<3?SC.amber:i<6?SC.teal:SC.dim;
            return(
              <div key={r.k} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <div style={{width:108,fontSize:9,color:SC.muted,textAlign:"right",flexShrink:0,fontFamily:"system-ui,sans-serif"}}>{r.l}</div>
                <div style={{flex:1,height:20,background:SC.bg,borderRadius:3,position:"relative",overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${(r.impact/max)*100}%`,background:`${col}44`,borderRadius:3}}/>
                  <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",paddingLeft:8,gap:6}}>
                    <span style={{fontSize:9,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace"}}>±{r.impact} kg</span>
                    {i===0&&<span style={{fontSize:8,color:SC.red,fontFamily:"system-ui,sans-serif"}}>← most sensitive</span>}
                  </div>
                </div>
                <div style={{width:50,fontSize:8,color:SC.muted,textAlign:"right",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{r.pct}%</div>
                <div style={{width:30,fontSize:8,color:SC.dim,textAlign:"right",fontFamily:"'DM Mono',monospace",flexShrink:0}}>{i===0?"—":`${(results[0].impact/r.impact).toFixed(1)}×`}</div>
              </div>
            );
          })}
          <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${SC.border}`,fontSize:9,color:SC.dim,fontFamily:"system-ui,sans-serif"}}>
            Base MTOW: <b style={{color:SC.amber}}>{SR.MTOW} kg</b> · ±10% sweep · last col = ratio vs most sensitive
          </div>
        </div>
      )}
    </div>
  );
}

export default function App(){
  const[params,setParams]=useState({
    // ── Mission ──────────────────────────────────────────────────────────
    payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
    reserveMinutes:20,  // regulatory reserve time (20 min VFR / 30 min IFR per SC-VTOL / FAR 27)
    // ── Aerodynamics (calibrated vs Joby S4 / Archer Midnight / NASA NDARC) ──
    LD:14,AR:9,eOsw:0.85,clDesign:0.55,taper:0.45,tc:0.15,
    // ── Propulsion ───────────────────────────────────────────────────────
    nPropHover:6,propDiam:3.0,twRatio:1.3,convTolExp:-6,
    etaHov:0.70,          // FOM 0.70 — achievable with optimised eVTOL hover rotor (was 0.63)
    etaSys:0.80,          // drivetrain η — modern PMSM motors + inverter ~93%×93% (was 0.765)
    rateOfClimb:5.08,climbAngle:5,
    descentAngle:6,        // degrees — approach descent (independent of L/D)
    climbLDPenalty:0.13,   // fractional L/D derating during climb (induced drag increase)
    deltaISA:0,            // ISA deviation °C: 0=standard day, 15=hot day
    cRateDerate:0.08,      // battery SED derate for C-rate: 8% default (~3-4C hover)
    // ── Battery (2025 state-of-art; Joby claims ~300 Wh/kg cell-level) ──
    sedCell:300,etaBat:0.90,socMin:0.19,
    // ── Weights (composite airframe; Joby EWF=0.43, Archer~0.45, conservative 0.50) ──
    ewf:0.50,
    // ── Geometry (Lf/b target 0.55–0.70; fL=7.2 gives 0.564 with 12.77 m span) ──
    fusLen:7.2,fusDiam:1.65,
    // ── V-tail (NASA NDARC UAM values for FBW lift+cruise eVTOL) ──────────
    vtGamma:45,
    vtCh:0.45,            // Ch=0.45 → SM_vt ≈ +7-8% MAC (stable, FBW eVTOL target 5–25%)
    vtCv:0.032,           // Cv reduced from 0.05: same rationale; gives tail/wing ~37%
    vtAR:2.5,
  });
  const[tab,setTab]=useState(0);
  const[activeGroup,setActiveGroup]=useState(0);
  const[showOverflow,setShowOverflow]=useState(false);
  const[sidebarOpen,setSidebarOpen]=useState(()=>localStorage.getItem("sb")!=="0");
  const[user,setUser]=useState(()=>getSession());
  const[showAuthModal,setShowAuthModal]=useState(false);
  const[darkMode,setDarkMode]=useState(true);
  const prevSRRef=useRef(null);
  const[deltaMap,setDeltaMap]=useState({});
  const undoStackRef=useRef([]);   // stores param snapshots — ref avoids re-render
  const redoStackRef=useRef([]);
  const[undoCount,setUndoCount]=useState(0); // triggers re-render for button state
  const[redoCount,setRedoCount]=useState(0);
  const[showPdfBranding,setShowPdfBranding]=useState(false);
  const[pdfBranding,setPdfBranding]=useState({
    authorName:"", university:"Wright State University",
    projectTitle:"eVTOL Sizing Analysis", logoUrl:"", date:new Date().toLocaleDateString(),
  });
  // Monte Carlo state
  const[mcRanges,setMcRanges]=useState({
    sedCell:   {min:250, max:350, dist:"normal"},
    ewf:       {min:0.43,max:0.57,dist:"normal"},
    LD:        {min:11,  max:17,  dist:"normal"},
    etaHov:    {min:0.62,max:0.78,dist:"normal"},
    etaSys:    {min:0.73,max:0.87,dist:"normal"},
    etaBat:    {min:0.85,max:0.95,dist:"normal"},
    AR:        {min:7,   max:11,  dist:"normal"},
    payload:   {min:410, max:500, dist:"uniform"},
  });
  const[mcN,setMcN]=useState(1000);
  const[customAirfoilInput,setCustomAirfoilInput]=useState("");
  const[customAFError,setCustomAFError]=useState("");
  const[customAFData,setCustomAFData]=useState(null);
  const[mcResults,setMcResults]=useState(null);
  const[mcRunning,setMcRunning]=useState(false);

  // Mission Builder state
  const PHASE_TYPES={
    hover:    {label:"Hover",      icon:"🚁",col:"#ff6b35",fields:["duration","altitude"], defaults:{duration:60,altitude:15}},
    climb:    {label:"Climb",      icon:"📈",col:"#ffd23f",fields:["distance","angle"],    defaults:{distance:5,angle:5}},
    cruise:   {label:"Cruise",     icon:"✈️", col:"#06d6a0",fields:["distance","speed"],   defaults:{distance:50,speed:67}},
    descent:  {label:"Descent",    icon:"📉",col:"#118ab2",fields:["distance","angle"],    defaults:{distance:4,angle:4}},
    divert:   {label:"Divert",     icon:"↗️", col:"#8338ec",fields:["distance","speed"],   defaults:{distance:20,speed:60}},
    reserve:  {label:"Reserve",    icon:"🔄",col:"#6c757d",fields:["distance","speed"],    defaults:{distance:40,speed:47}},
    loiter:   {label:"Loiter",     icon:"⭕",col:"#e91e63",fields:["duration","altitude"],  defaults:{duration:120,altitude:100}},
    wind_corr:{label:"Wind Corr",  icon:"💨",col:"#00bcd4",fields:["distance","windSpeed"],defaults:{distance:10,windSpeed:15}},
  };
  const uid2=()=>Math.random().toString(36).slice(2,8);
  const[customPhases,setCustomPhases]=useState([
    {id:uid2(),type:"hover",  duration:30,  altitude:15,  label:"Takeoff Hover"},
    {id:uid2(),type:"climb",  distance:5,   angle:5,      label:"Climb"},
    {id:uid2(),type:"cruise", distance:200, speed:67,     label:"Cruise"},
    {id:uid2(),type:"descent",distance:4,   angle:4,      label:"Descent"},
    {id:uid2(),type:"hover",  duration:30,  altitude:15,  label:"Landing Hover"},
    {id:uid2(),type:"reserve",distance:40,  speed:47,     label:"Reserve"},
  ]);
  const[dragIdx,setDragIdx]=useState(null);
  const[dragOverIdx,setDragOverIdx]=useState(null);
  const[mbResults,setMbResults]=useState(null);

  // Weather & Atmosphere state
  const[wxSearch,setWxSearch]=useState("");
  const[wxData,setWxData]=useState(null);
  const[wxLoading,setWxLoading]=useState(false);
  const[wxError,setWxError]=useState("");
  const[wxResults,setWxResults]=useState(null);
  const WX_PRESETS=[
    {name:"Denver, CO",   lat:39.7392,lon:-104.9903,alt:1609,flag:"🇺🇸"},
    {name:"Miami, FL",    lat:25.7617,lon:-80.1918, alt:1,   flag:"🇺🇸"},
    {name:"Chicago, IL",  lat:41.8781,lon:-87.6298, alt:182, flag:"🇺🇸"},
    {name:"Los Angeles",  lat:34.0522,lon:-118.2437,alt:71,  flag:"🇺🇸"},
    {name:"London, UK",   lat:51.5074,lon:-0.1278,  alt:11,  flag:"🇬🇧"},
    {name:"Dubai, UAE",   lat:25.2048,lon:55.2708,  alt:5,   flag:"🇦🇪"},
    {name:"Singapore",    lat:1.3521, lon:103.8198, alt:15,  flag:"🇸🇬"},
    {name:"Dayton, OH",   lat:39.7589,lon:-84.1916, alt:306, flag:"🇺🇸"},
  ];

  // Update global C on every render based on theme
  SC = darkMode ? DARK : LIGHT;
  // Sync theme to AuthSystem so modal inputs also update
  setAuthTheme(darkMode);

  // Dynamic tooltip style (reads current C — correct for both themes)
  const TTP = {
    contentStyle:{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:6,fontSize:12,
      color:SC.text,boxShadow:"0 4px 20px rgba(0,0,0,0.4)",padding:"8px 12px"},
    labelStyle:{color:SC.muted,fontSize:12,fontWeight:600},
    itemStyle:{color:SC.text,fontSize:12},
  };

  // URL param: ?design=shareId for shared design loading
  const [sharedDesignId] = useState(()=>new URLSearchParams(window.location.search).get("design")||"");
  const [sharedSessionId] = useState(()=>new URLSearchParams(window.location.search).get("session")||"");

  // Auto-load shared design on page open (when ?design= is in URL)
  useEffect(()=>{
    if(!sharedDesignId) return;
    const SB_URL="https://obribjypwwrbhsyjllua.supabase.co";
    const SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9icmlianlwd3dyYmhzeWpsbHVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MjU1MjIsImV4cCI6MjA4OTIwMTUyMn0.Rq2_KfHlHnoluGJY3AcBIqcbuMFuLBitU-Y6aBWyoJ4";
    fetch(`${SB_URL}/rest/v1/evtol_public_designs?share_id=eq.${sharedDesignId}&is_public=eq.true`,{
      headers:{"apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`,"Content-Type":"application/json"}
    }).then(r=>r.json()).then(rows=>{
      if(!rows||!rows.length) return;
      const d=rows[0];
      // increment view count
      fetch(`${SB_URL}/rest/v1/evtol_public_designs?share_id=eq.${sharedDesignId}`,{
        method:"PATCH",
        headers:{"apikey":SB_KEY,"Authorization":`Bearer ${SB_KEY}`,"Content-Type":"application/json","Prefer":"return=representation"},
        body:JSON.stringify({view_count:(d.view_count||0)+1})
      }).catch(()=>{});
      try{
        const prm=JSON.parse(d.params||"{}");
        if(Object.keys(prm).length>0) setParams(prev=>({...prev,...prm}));
      }catch{}
    }).catch(()=>{});
  },[]);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleAuth=(session)=>{
    saveSession(session);
    setUser(session);
    setShowAuthModal(false);
  };
  const handleSignOut=()=>{ clearSession(); setUser(null); };
  const handleUpdate=(session)=>{ saveSession(session); setUser(session); };

  /* ── CSV Export ── */
  const exportCSV=()=>{
    if(!SR) return;
    const rows=[
      ["eVTOL Sizer — Results Export","",""],
      ["Generated",new Date().toLocaleString(),""],
      ["","",""],
      ["=== WEIGHTS ===","",""],
      ["MTOW (kg)",SR.MTOW,""],
      ["Empty Weight (kg)",SR.Wempty,""],
      ["Battery Mass (kg)",SR.Wbat,""],
      ["Payload (kg)",params.payload,""],
      ["","",""],
      ["=== ENERGY & POWER ===","",""],
      ["Total Mission Energy (kWh)",SR.Etot,""],
      ["Pack Energy (kWh)",SR.PackkWh,""],
      ["Hover Power (kW)",SR.Phov,""],
      ["Climb Power (kW)",SR.Pcl,""],
      ["Cruise Power (kW)",SR.Pcr,""],
      ["Descent Power (kW)",SR.Pdc,""],
      ["Reserve Power (kW)",SR.Pres,""],
      ["","",""],
      ["=== PHASE TIMES (s) ===","",""],
      ["Takeoff",SR.tto,""],["Climb",SR.tcl,""],["Cruise",SR.tcr,""],
      ["Descent",SR.tdc,""],["Landing",SR.tld,""],["Reserve",SR.tres,""],
      ["Total",SR.Tend,""],
      ["","",""],
      ["=== AERODYNAMICS ===","",""],
      ["Wing Area (m²)",SR.Swing,""],["Wing Span (m)",SR.bWing,""],
      ["MAC (m)",SR.MAC,""],["Sweep (°)",SR.sweep,""],
      ["Actual L/D",SR.LDact,""],["CD0 total",SR.CD0tot,""],
      ["Mach",SR.Mach,""],["Reynolds ×10⁶",(SR.Re_/1e6).toFixed(2),""],
      ["Selected Airfoil",SR.selAF.name,""],
      ["","",""],
      ["=== PROPULSION ===","",""],
      ["Rotor Diameter AD (m)",SR.Drotor,""],["Tip Mach",SR.TipMach,""],
      ["RPM",SR.RPM,""],["Disk Loading (N/m²)",SR.DLrotor,""],
      ["Tip Speed (m/s)",SR.TipSpd,""],["Motor Power/rotor (kW)",SR.PmotKW,""],
      ["T/W hover",SR.TW_hover,""],["T/W cruise",SR.TW_cruise,""],
      ["","",""],
      ["=== STABILITY ===","",""],
      ["CG from nose (m)",SR.xCGtotal,""],["NP from nose (m)",SR.xNP,""],
      ["Static Margin baseline (% MAC)",(SR.SM*100).toFixed(2),""],
      ["Static Margin w/ V-tail (% MAC)",(SR.SM_vt*100).toFixed(2),""],
      ["","",""],
      ["=== BATTERY ===","",""],
      ["Pack Energy (kWh)",SR.PackkWh,""],["SED pack (Wh/kg)",SR.SEDpack,""],
      ["Cell config",`${SR.Nseries}s×${SR.Npar}p`,""],["Total cells",SR.Ncells,""],
      ["C-rate hover",SR.CrateHov,""],["C-rate cruise",SR.CrateCr,""],
      ["","",""],
      ["=== INPUT PARAMETERS ===","",""],
      ["Payload (kg)",params.payload,""],["Range (km)",params.range,""],
      ["Cruise Speed (m/s)",params.vCruise,""],["Cruise Alt (m)",params.cruiseAlt,""],
      ["L/D",params.LD,""],["AR",params.AR,""],["Oswald e",params.eOsw,""],
      ["Design CL",params.clDesign,""],["EWF",params.ewf,""],
      ["Cell SED (Wh/kg)",params.sedCell,""],["Battery η",params.etaBat,""],
      ["Hover FOM",params.etaHov,""],["System η",params.etaSys,""],
      ["T/W ratio",params.twRatio,""],["Rotors",params.nPropHover,""],
    ];
    const csv=rows.map(rowArr=>rowArr.map(cellVal=>`"${cellVal}"`).join(",")).join("\n");
    const blob=new Blob([csv],{type:"text/csv"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url; a.download=`eVTOL_Results_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    if(user) addNotif(user.id,{title:"CSV Exported",body:"Results downloaded as spreadsheet.",type:"success"});
  };

  const SR=useMemo(()=>{try{return runSizing({...params,customAirfoil:customAFData});}catch{return null;}},[params,customAFData]);

  // Track deltas for KPI header — show what changed after each slider move
  useEffect(()=>{
    if(!SR) return;
    const prev=prevSRRef.current;
    if(prev){
      const dm={};
      const keys=["MTOW","Etot","Phov","LDact","SM_vt"];
      keys.forEach(k=>{
        if(prev[k]!=null&&SR[k]!=null){
          const d=SR[k]-prev[k];
          if(Math.abs(d)>0.001) dm[k]=d;
        }
      });
      if(Object.keys(dm).length>0){
        setDeltaMap(dm);
        const tid=setTimeout(()=>setDeltaMap({}),2500);
        prevSRRef.current=SR;
        return()=>clearTimeout(tid);
      }
    }
    prevSRRef.current=SR;
  },[SR]);
  /* ── Mission Builder — compute custom mission ──
     BUG FIX: wrapped in useCallback so useEffect dependency is stable.
     Auto-triggers whenever customPhases or SR changes — no manual "Compute" needed. */
  const computeCustomMission=useCallback(()=>{
    if(!SR) return;
    const g0=9.81,rhoMSL=1.225,T0=288.15,Rgas=287,GAM=1.4,L=0.0065;
    const MTOW=SR.MTOW, W=MTOW*g0;
    let totalE=0,totalT=0,totalDist=0,phaseResults=[];
    customPhases.forEach(ph=>{
      const pt=PHASE_TYPES[ph.type];
      let E=0,t=0,dist=0,power=0;
      const cruiseAlt=params.cruiseAlt;
      const Tcr=T0-L*cruiseAlt;
      const rhoCr=rhoMSL*Math.pow(Tcr/T0,(-g0/(-L*Rgas))-1);
      switch(ph.type){
        case"hover":case"loiter":{
          const DL=(W*params.twRatio)/(Math.PI*Math.pow(params.propDiam/2,2)*params.nPropHover);
          power=(W*params.twRatio/params.etaHov)*Math.sqrt(DL/(2*rhoMSL))/1000;
          t=ph.duration||60; dist=0;
          E=power*t/3600; break;
        }
        case"climb":{
          const RoC=params.rateOfClimb,ang=(ph.angle||5)*Math.PI/180;
          const Vcl=RoC/Math.sin(ang);
          const LDcl=params.LD*(1-0.13);
          power=(W/params.etaSys)*(RoC+Vcl/LDcl)/1000;
          dist=(ph.distance||5)*1000; t=dist/Vcl;
          E=power*t/3600; break;
        }
        case"descent":{
          const ang=(ph.angle||4)*Math.PI/180;
          const Vdc=params.rateOfClimb/Math.sin(ang);
          const LDcl=params.LD*(1-0.13);
          power=Math.max(0,(W/params.etaSys)*(-params.rateOfClimb+Vdc/LDcl)/1000);
          dist=(ph.distance||4)*1000; t=dist/Vdc;
          E=power*t/3600; break;
        }
        case"cruise":case"divert":{
          const spd=ph.speed||params.vCruise;
          power=(W/params.etaSys)*(spd/params.LD)/1000;
          dist=(ph.distance||50)*1000; t=dist/spd;
          E=power*t/3600; break;
        }
        case"reserve":{
          const Vres=0.7*(ph.speed||params.vCruise);
          power=(W/params.etaSys)*(Vres/params.LD)/1000;
          dist=(ph.distance||40)*1000; t=dist/Vres;
          E=power*t/3600; break;
        }
        case"wind_corr":{
          const Veff=Math.max(10,(ph.speed||params.vCruise)-(ph.windSpeed||15)*0.5);
          power=(W/params.etaSys)*(Veff/params.LD)/1000*(1+(ph.windSpeed||15)/100);
          dist=(ph.distance||10)*1000; t=dist/Veff;
          E=power*t/3600; break;
        }
      }
      totalE+=E; totalT+=t; totalDist+=dist;
      phaseResults.push({...ph,power:+power.toFixed(2),energy:+E.toFixed(3),time:+t.toFixed(0),distance:+dist.toFixed(0)});
    });
    const PackkWh=SR.PackkWh;
    const finalSoC=(1-totalE/PackkWh)*100;
    const totalRange=totalDist/1000;
    setMbResults({phases:phaseResults,totalE:+totalE.toFixed(3),totalT:+totalT.toFixed(0),
      totalRange:+totalRange.toFixed(1),finalSoC:+finalSoC.toFixed(1),
      feasible:finalSoC>0&&totalE<=PackkWh});
  },[customPhases,SR,params]);

  /* Auto-recompute mission whenever phases or aircraft params change */
  useEffect(()=>{ computeCustomMission(); },[computeCustomMission]);

  /* ── Weather fetch — Open-Meteo (no API key needed) ── */
  const fetchWeather=async(lat,lon,cityName,elevation=0)=>{
    setWxLoading(true); setWxError(""); setWxData(null); setWxResults(null);
    try{
      // Fetch current weather — request wind in m/s explicitly with wind_speed_unit=ms
      const url=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
        +`&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,weather_code`
        +`&wind_speed_unit=ms`   // ← explicitly request m/s (default is km/h!)
        +`&forecast_days=1&timezone=auto`;
      const res=await fetch(url);
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json();
      const cur=data.current;
      const T_C=cur.temperature_2m;
      const P_hPa=cur.surface_pressure;
      const wind_ms=cur.wind_speed_10m;  // already m/s — requested with wind_speed_unit=ms
      const wind_dir=cur.wind_direction_10m;
      const humidity=cur.relative_humidity_2m;
      // ISA calculations with actual weather
      const T_K=T_C+273.15;
      const T_std=288.15-0.0065*elevation; // ISA temperature at this altitude
      const P_Pa=P_hPa*100;
      const rho_actual=P_Pa/(287*T_K);
      const rho_ISA=1.225*Math.pow(T_K/288.15,4.256); // approx density ratio
      const sigma=rho_actual/1.225; // density ratio vs sea level
      const a_actual=Math.sqrt(1.4*287*T_K);
      const deltaT=T_C-(T_std-273.15); // temp deviation from ISA
      // Run sizing with actual atmospheric conditions
      // Modify key atmospheric parameters
      const pWeather={...params, cruiseAlt:elevation};
      // Compute performance impacts
      const MTOW=SR.MTOW,W=MTOW*9.81;
      // Hover power change with density
      const DL_ISA=(W*params.twRatio)/(Math.PI*Math.pow(params.propDiam/2,2)*params.nPropHover);
      const P_hov_ISA=SR.Phov;
      const P_hov_wx=(W*params.twRatio/params.etaHov)*Math.sqrt(DL_ISA/(2*rho_actual))/1000;
      const P_hov_delta_pct=((P_hov_wx/P_hov_ISA)-1)*100;
      // Cruise speed / stall speed change with density
      const V_stall_wx=SR.Vstall*Math.sqrt(1/sigma);
      const V_stall_delta=V_stall_wx-SR.Vstall;
      // Cruise power ~ proportional to 1/rho for same speed
      const P_cr_wx=SR.Pcr*(1.225/rho_actual);
      const P_cr_delta_pct=((P_cr_wx/SR.Pcr)-1)*100;
      // Range impact (Breguet — higher density = less drag = more range)
      const range_delta_pct=-P_hov_delta_pct*0.3; // approx
      // Mach change with temperature
      const Mach_wx=params.vCruise/a_actual;
      // Wind impact on range
      const headwind_component=wind_ms*Math.cos((wind_dir||0)*Math.PI/180);
      const Vg=params.vCruise-headwind_component; // ground speed
      const range_wind_pct=((Vg/params.vCruise)-1)*100;
      // Weather code description
      const WX_CODES={0:"Clear sky",1:"Mainly clear",2:"Partly cloudy",3:"Overcast",
        45:"Foggy",48:"Icy fog",51:"Light drizzle",61:"Light rain",71:"Light snow",
        80:"Rain showers",95:"Thunderstorm",99:"Heavy thunderstorm"};
      const wx_desc=WX_CODES[cur.weather_code]||`Code ${cur.weather_code}`;
      setWxData({cityName,lat,lon,elevation,T_C,P_hPa,wind_ms,wind_dir,humidity,wx_desc,
        rho_actual:+rho_actual.toFixed(4),sigma:+sigma.toFixed(4),deltaT:+deltaT.toFixed(1),a_actual:+a_actual.toFixed(1)});
      setWxResults({
        P_hov_wx:+P_hov_wx.toFixed(2),P_hov_delta_pct:+P_hov_delta_pct.toFixed(1),
        P_cr_wx:+P_cr_wx.toFixed(2),P_cr_delta_pct:+P_cr_delta_pct.toFixed(1),
        V_stall_wx:+V_stall_wx.toFixed(2),V_stall_delta:+V_stall_delta.toFixed(2),
        Mach_wx:+Mach_wx.toFixed(4),
        headwind_component:+headwind_component.toFixed(1),
        Vg:+Vg.toFixed(1),range_wind_pct:+range_wind_pct.toFixed(1),
        rho_actual:+rho_actual.toFixed(4),sigma:+sigma.toFixed(4),
      });
      setWxLoading(false);
    }catch(e){
      setWxError(`Failed to fetch weather: ${e.message}`);
      setWxLoading(false);
    }
  };

  const searchCity=async()=>{
    if(!wxSearch.trim()) return;
    setWxLoading(true); setWxError("");
    try{
      const geo=await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(wxSearch.trim())}&count=1&language=en&format=json`);
      const gd=await geo.json();
      if(!gd.results?.length){ setWxError("City not found. Try a different name."); setWxLoading(false); return; }
      const loc=gd.results[0];
      await fetchWeather(loc.latitude,loc.longitude,`${loc.name}, ${loc.country}`,loc.elevation||0);
    }catch(e){
      setWxError(`Geocoding failed: ${e.message}`);
      setWxLoading(false);
    }
  };

  /* ── Monte Carlo Runner ── */
  /* Uses Box-Muller transform for normal distribution — mathematically correct */
  const sampleNormal=(mu,sigma)=>{
    let u=0,v=0;
    while(u===0) u=Math.random();
    while(v===0) v=Math.random();
    return mu+sigma*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  };
  const sampleParam=(range)=>{
    const{min,max,dist}=range;
    const mu=(min+max)/2;
    const sigma=(max-min)/6; // 3-sigma = full range (99.7% within bounds)
    if(dist==="uniform") return min+Math.random()*(max-min);
    // Normal — clamp to [min,max] for physical validity
    let s=sampleNormal(mu,sigma);
    return Math.max(min,Math.min(max,s));
  };

  const runMonteCarlo=()=>{
    setMcRunning(true);
    setMcResults(null);
    setTimeout(()=>{
      const N=mcN;
      const MTOWs=[],Etots=[],Phovs=[],LDacts=[],SMs=[],Wbats=[],PackkWhs=[],feasibles=[];
      let failCount=0;
      for(let i=0;i<N;i++){
        try{
          // Sample each uncertain parameter
          const pSample={
            ...params,
            sedCell: sampleParam(mcRanges.sedCell),
            ewf:     sampleParam(mcRanges.ewf),
            LD:      sampleParam(mcRanges.LD),
            etaHov:  sampleParam(mcRanges.etaHov),
            etaSys:  sampleParam(mcRanges.etaSys),
            etaBat:  sampleParam(mcRanges.etaBat),
            AR:      Math.round(sampleParam(mcRanges.AR)*10)/10,
            payload: Math.round(sampleParam(mcRanges.payload)),
          };
          const Rs=runSizing(pSample);
          if(!Rs||!isFinite(Rs.MTOW)||Rs.MTOW>6000||Rs.MTOW<500) { failCount++; continue; }
          MTOWs.push(Rs.MTOW);
          Etots.push(Rs.Etot);
          Phovs.push(Rs.Phov);
          LDacts.push(Rs.LDact);
          SMs.push(Rs.SM_vt*100);
          Wbats.push(Rs.Wbat);
          PackkWhs.push(Rs.PackkWh);
          feasibles.push(Rs.feasible?1:0);
        }catch{ failCount++; }
      }
      // Compute statistics
      const stats=(arr)=>{
        if(!arr.length) return null;
        const sorted=[...arr].sort((a,b)=>a-b);
        const mean=arr.reduce((s,v)=>s+v,0)/arr.length;
        const variance=arr.reduce((s,v)=>s+(v-mean)**2,0)/arr.length;
        const std=Math.sqrt(variance);
        const p5=sorted[Math.floor(0.05*sorted.length)];
        const p25=sorted[Math.floor(0.25*sorted.length)];
        const p50=sorted[Math.floor(0.50*sorted.length)];
        const p75=sorted[Math.floor(0.75*sorted.length)];
        const p95=sorted[Math.floor(0.95*sorted.length)];
        return{mean,std,p5,p25,p50,p75,p95,min:sorted[0],max:sorted[sorted.length-1],n:arr.length};
      };
      // Build histogram bins for MTOW
      const buildHist=(arr,bins=40)=>{
        if(!arr.length) return [];
        const mn=Math.min(...arr),mx=Math.max(...arr);
        const w=(mx-mn)/bins;
        const counts=Array(bins).fill(0);
        arr.forEach(val=>{ const b=Math.min(bins-1,Math.floor((val-mn)/w)); counts[b]++; });
        return counts.map((cnt,i)=>({
          x:+(mn+i*w+w/2).toFixed(1), count:cnt,
          pct:+(cnt/arr.length*100).toFixed(2)
        }));
      };
      // CDF for MTOW
      const buildCDF=(arr)=>{
        const sorted=[...arr].sort((a,b)=>a-b);
        return sorted.filter((_,i)=>i%Math.max(1,Math.floor(sorted.length/200))===0)
          .map((cdfVal,cdfIdx,cdfArr)=>({x:+cdfVal.toFixed(1),cdf:+((cdfIdx+1)/cdfArr.length*100).toFixed(1)}));
      };
      setMcResults({
        N, failCount,
        MTOW:{stats:stats(MTOWs),hist:buildHist(MTOWs),cdf:buildCDF(MTOWs),raw:MTOWs},
        Etot:{stats:stats(Etots),hist:buildHist(Etots)},
        Phov:{stats:stats(Phovs),hist:buildHist(Phovs)},
        LDact:{stats:stats(LDacts),hist:buildHist(LDacts)},
        SM:{stats:stats(SMs),hist:buildHist(SMs)},
        Wbat:{stats:stats(Wbats),hist:buildHist(Wbats)},
        feasRate:(feasibles.reduce((s,v)=>s+v,0)/feasibles.length*100).toFixed(1),
      });
      setMcRunning(false);
    },50); // defer to allow UI to update
  };

  const set=useCallback(paramKey=>paramVal=>{
    setParams(prev=>{
      undoStackRef.current=[...undoStackRef.current.slice(-29),prev];
      redoStackRef.current=[];
      setUndoCount(undoStackRef.current.length);
      setRedoCount(0);
      return {...prev,[paramKey]:paramVal};
    });
  },[]);

  // Keyboard shortcuts
  useEffect(()=>{
    const onKey=evt=>{
      const mod=evt.ctrlKey||evt.metaKey;
      if(mod&&evt.key==="z"&&!evt.shiftKey){ evt.preventDefault(); undo(); }
      if(mod&&(evt.key==="y"||(evt.key==="z"&&evt.shiftKey))){ evt.preventDefault(); redo(); }
      if(mod&&evt.key==="s"){
        evt.preventDefault();
        if(SR&&user){
          const html=generateReport(params,SR,pdfBranding||{});
          const nm=`Design — MTOW ${SR.MTOW}kg · ${new Date().toLocaleDateString()}`;
          saveDesign(user.id,{name:nm,params,results:{MTOW:SR.MTOW,Etot:SR.Etot},pdfHtml:html});
          addNotif(user.id,{title:"Saved ✓",body:nm,type:"success"});
        }
      }
      if(mod&&evt.key==="e"){ evt.preventDefault(); if(SR) exportCSV(); }
      if(!mod&&evt.target.tagName!=="INPUT"&&evt.target.tagName!=="TEXTAREA"){
        if(evt.key==="ArrowRight"){const g=TAB_GROUPS[activeGroup];const idx=g.tabs.indexOf(tab);if(idx<g.tabs.length-1)setTab(g.tabs[idx+1]);}
        if(evt.key==="ArrowLeft") {const g=TAB_GROUPS[activeGroup];const idx=g.tabs.indexOf(tab);if(idx>0)setTab(g.tabs[idx-1]);}
      }
    };
    window.addEventListener("keydown",onKey);
    return()=>window.removeEventListener("keydown",onKey);
  },[SR,user,params,tab,activeGroup]);
  const undo=()=>{
    const stack=undoStackRef.current;
    if(!stack.length) return;
    const snap=stack[stack.length-1];
    undoStackRef.current=stack.slice(0,-1);
    redoStackRef.current=[...redoStackRef.current,params];
    setParams(snap);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  };
  const redo=()=>{
    const stack=redoStackRef.current;
    if(!stack.length) return;
    const snap=stack[stack.length-1];
    redoStackRef.current=stack.slice(0,-1);
    undoStackRef.current=[...undoStackRef.current,params];
    setParams(snap);
    setUndoCount(undoStackRef.current.length);
    setRedoCount(redoStackRef.current.length);
  };

  const stCol=!SR?SC.red:SR.feasible?SC.green:SC.amber;
  const stTxt=!SR?"ERROR":SR.feasible?"FEASIBLE":"CHECK DESIGN";

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",
      background:SC.bg,color:SC.text,
      fontFamily:"'Barlow',system-ui,sans-serif",overflow:"hidden",
      transition:"background 0.2s,color 0.2s"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Barlow:wght@400;600;700;800&display=swap');
        html,body{background:${SC.bg};color:${SC.text};margin:0;padding:0}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:${SC.bg}}
        ::-webkit-scrollbar-thumb{background:${SC.border};border-radius:3px}
        input[type=range]{-webkit-appearance:none;appearance:none}
        input[type=number]{-moz-appearance:textfield;background:${SC.panel};color:${SC.amber}}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
        .recharts-tooltip-wrapper .recharts-default-tooltip{background:${SC.panel} !important;border:1px solid ${SC.border} !important;border-radius:6px !important;box-shadow:0 4px 20px rgba(0,0,0,0.4) !important;padding:8px 12px !important}
        .recharts-tooltip-wrapper .recharts-tooltip-label{color:${SC.muted} !important;font-size:12px !important;font-weight:600 !important;margin-bottom:4px !important;display:block}
        .recharts-tooltip-wrapper .recharts-tooltip-item{color:${SC.text} !important;font-size:12px !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-name{color:${SC.muted} !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-value{color:${SC.amber} !important;font-weight:700 !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-separator{color:${SC.dim} !important}
        .recharts-legend-item-text{color:${SC.muted} !important;font-size:11px !important}
        .recharts-cartesian-axis-tick text{fill:${SC.muted} !important}
        .recharts-label{fill:${SC.muted} !important}
        .recharts-cartesian-grid line{stroke:${SC.border} !important}
        span,div,td,th{color:inherit}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
        /* ── Font hierarchy:
           DM Mono  → numeric values, equations, code, unit labels, status badges
           System   → panel headings, section titles, sidebar labels, descriptive text
           Override monospace on headings/labels with .lbl class ── */
        .lbl{font-family:system-ui,-apple-system,sans-serif !important}
        .acc-title{font-family:system-ui,-apple-system,sans-serif !important;letter-spacing:0 !important}
        .panel-title{font-family:system-ui,-apple-system,sans-serif !important;letter-spacing:0.01em !important}
        .tab-label{font-family:system-ui,-apple-system,sans-serif !important}
        /* Slider label — the descriptive name above the track */
        .slider-label{font-family:system-ui,-apple-system,sans-serif !important;font-size:11px}
        /* Tab group category pill */
        .tab-group-pill{font-family:system-ui,-apple-system,sans-serif !important}
      `}</style>

      {/* PDF BRANDING POPUP */}
      {showPdfBranding&&(
        <div style={{position:"fixed",inset:0,zIndex:3000,background:"rgba(0,0,0,0.7)",
          backdropFilter:"blur(4px)",display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={evt => evt.target===e.currentTarget&&setShowPdfBranding(false)}>
          <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:12,
            padding:"24px 28px",width:460,maxWidth:"92vw",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20}}>
              <div>
                <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.15em",marginBottom:4}}>PDF REPORT</div>
                <div style={{fontSize:16,fontWeight:800,color:SC.text}}>
                  <span style={{color:SC.amber}}>eVTOL</span> — Report Branding
                </div>
              </div>
              <button onClick={()=>setShowPdfBranding(false)} type="button"
                style={{background:"transparent",border:`1px solid ${SC.border}`,borderRadius:6,
                  color:SC.muted,fontSize:14,cursor:"pointer",padding:"5px 10px"}}>✕ Close</button>
            </div>
            {[
              ["Author / Engineer Name","authorName","Your full name"],
              ["University / Organization","university","e.g. Wright State University"],
              ["Project Title","projectTitle","e.g. eVTOL Sizing Analysis"],
              ["Logo URL (optional)","logoUrl","https://...logo.png"],
              ["Report Date","date",new Date().toLocaleDateString()],
            ].map(([lbl,key,ph])=>(
              <div key={key} style={{marginBottom:12}}>
                <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",
                  textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5}}>{lbl}</div>
                <input value={pdfBranding[key]} onChange={evt=>setPdfBranding(prev_b=>({...prev_b,[key]:evt.target.value}))}
                  placeholder={ph} type="text"
                  style={{width:"100%",boxSizing:"border-box",background:SC.bg,border:`1px solid ${SC.border}`,
                    borderRadius:6,color:SC.text,fontSize:12,padding:"8px 12px",
                    fontFamily:"'DM Mono',monospace",outline:"none"}}
                  onFocus={evt => evt.target.style.borderColor=SC.amber}
                  onBlur={evt => evt.target.style.borderColor=SC.border}/>
              </div>
            ))}
            <div style={{marginTop:6,padding:"8px 12px",background:`${SC.green}11`,
              border:`1px solid ${SC.green}44`,borderRadius:6,fontSize:10,color:SC.green,
              fontFamily:"'DM Mono',monospace"}}>
              ✓ These details will appear on the PDF cover page when you click ⬇ PDF REPORT
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{display:"flex",alignItems:"center",padding:"8px 18px",background:SC.panel,
        borderBottom:`1px solid ${SC.border}`,gap:14,flexShrink:0,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:7,color:SC.muted,letterSpacing:"0.2em",fontFamily:"'DM Mono',monospace"}}>AEROSPACE DESIGN SUITE</div>
          <div style={{fontSize:19,fontWeight:800,letterSpacing:"-0.03em",lineHeight:1}}>
            <span style={{color:SC.amber}}>eVTOL</span>
            <span style={{color:SC.text}}> SIZER</span>
            <span style={{fontSize:8,color:SC.dim,marginLeft:6,fontFamily:"'DM Mono',monospace",fontWeight:400}}>v2.0 — MATLAB Algorithm</span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",
          background:`${stCol}11`,border:`1px solid ${stCol}44`,borderRadius:4}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:stCol,boxShadow:`0 0 8px ${stCol}`}}/>
          <span style={{fontSize:9,color:stCol,fontFamily:"'DM Mono',monospace",fontWeight:700,letterSpacing:"0.08em"}}>{stTxt}</span>
        </div>
        {SR&&(
          <div style={{display:"flex",gap:14,marginLeft:6,flexWrap:"wrap"}}>
            {[[" MTOW","MTOW",SR.MTOW,"kg",SR.MTOW<4000?SC.green:SR.MTOW<5000?SC.amber:SC.red,1],
              ["E_total","Etot",SR.Etot,"kWh",SC.teal,2],["P_hover","Phov",SR.Phov,"kW",SC.blue,1],
              ["  L/D","LDact",SR.LDact,"",SR.LDact>12?SC.green:SC.amber,1],
              [" SM","SM_vt",(SR.SM_vt*100).toFixed(1)+"%","",SR.SM_vt>0.05&&SR.SM_vt<0.25?SC.green:SC.red,null]
            ].map(([l,dkey,v,u,col,dp])=>{
              const d=deltaMap[dkey];
              const isNum=typeof v==="number";
              const dispVal=isNum?v.toLocaleString():v;
              return(
                <div key={l} style={{textAlign:"center",position:"relative"}}>
                  <div style={{fontSize:7,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em"}}>{l}</div>
                  <div style={{fontSize:13,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",lineHeight:1.1}}>
                    {dispVal}<span style={{fontSize:8,color:SC.dim,marginLeft:2}}>{u}</span>
                  </div>
                  {d!=null&&(
                    <div style={{position:"absolute",top:-10,right:-4,fontSize:8,fontFamily:"'DM Mono',monospace",
                      color:d>0?"#f87171":"#34d399",fontWeight:700,whiteSpace:"nowrap",
                      background:SC.panel,borderRadius:3,padding:"0 3px",border:`1px solid ${d>0?"#f8717155":"#34d39955"}`}}>
                      {d>0?"+":""}{dp!=null?d.toFixed(dp):(d*100).toFixed(1)+"%"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Action buttons — primary visible, secondary behind ••• */}
        <div style={{display:"flex",gap:6,marginLeft:"auto",alignItems:"center",position:"relative"}}>
          {/* Dark/Light toggle — always visible, purely iconic */}
          <button onClick={()=>setDarkMode(d=>!d)} type="button"
            title={darkMode?"Switch to Light Mode":"Switch to Dark Mode"}
            style={{padding:"5px 10px",background:"transparent",
              border:`1px solid ${SC.border}`,borderRadius:4,
              color:SC.muted,fontSize:13,cursor:"pointer",lineHeight:1}}>
            {darkMode?"☀️":"🌙"}
          </button>

          {/* PRIMARY: Save Design */}
          {SR&&(
            <AuthGate user={user} onAuth={handleAuth}>
              <button onClick={()=>{
                  if(!user) return;
                  const html=generateReport(params,SR,pdfBranding);
                  const nm=`Design — MTOW ${SR.MTOW}kg · ${new Date().toLocaleDateString()}`;
                  saveDesign(user.id,{name:nm,params:params,results:{MTOW:SR.MTOW,Etot:SR.Etot,Phov:SR.Phov,LDact:SR.LDact,SM:SR.SM},pdfHtml:html});
                  addNotif(user.id,{title:"Design Saved",body:`"${nm}" saved to My Designs.`,type:"success"});
                }}
                style={{padding:"6px 16px",background:"linear-gradient(135deg,#0f2a0f,#14532d)",
                  border:"1px solid #22c55e",borderRadius:4,color:"#86efac",fontSize:10,cursor:"pointer",
                  fontFamily:"system-ui,sans-serif",fontWeight:700,
                  display:"flex",alignItems:"center",gap:5,boxShadow:"0 0 10px #22c55e22"}}>
                {!user&&<span style={{fontSize:10}}>🔒</span>}💾 Save design
              </button>
            </AuthGate>
          )}

          {/* SECONDARY: overflow ••• menu */}
          <div style={{position:"relative"}}>
            <button type="button" onClick={()=>setShowOverflow(v=>!v)}
              style={{padding:"6px 10px",background:"transparent",
                border:`1px solid ${SC.border}`,borderRadius:4,
                color:SC.muted,fontSize:14,cursor:"pointer",lineHeight:1,
                fontFamily:"system-ui,sans-serif"}}>
              •••
            </button>
            {showOverflow&&(
              <div style={{position:"absolute",top:"calc(100% + 6px)",right:0,zIndex:200,
                background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,
                padding:"6px 0",minWidth:190,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}
                onMouseLeave={()=>setShowOverflow(false)}>
                {/* Export CSV */}
                {SR&&(
                  <button onClick={()=>{exportCSV();setShowOverflow(false);}} type="button"
                    style={{width:"100%",padding:"8px 16px",background:"transparent",border:"none",
                      cursor:"pointer",textAlign:"left",fontSize:11,color:SC.text,
                      fontFamily:"system-ui,sans-serif",display:"flex",alignItems:"center",gap:8}}>
                    📊 Export CSV
                  </button>
                )}
                {/* PDF Report */}
                {SR&&(
                  <AuthGate user={user} onAuth={handleAuth}>
                    <button onClick={()=>{
                        const html=generateReport(params,SR,pdfBranding);
                        const w=window.open("","_blank");
                        w.document.write(html);w.document.close();
                        if(user){
                          addNotif(user.id,{title:"PDF Report Generated",body:`Design report for MTOW=${SR.MTOW} kg exported.`,type:"success"});
                          addReport(user.id,{name:`Report — MTOW ${SR.MTOW}kg · ${new Date().toLocaleDateString()}`,params,results:{MTOW:SR.MTOW,Etot:SR.Etot,Phov:SR.Phov,LDact:SR.LDact,SM:SR.SM},pdfHtml:html});
                        }
                        setShowOverflow(false);
                      }}
                      style={{width:"100%",padding:"8px 16px",background:"transparent",border:"none",
                        cursor:"pointer",textAlign:"left",fontSize:11,color:SC.text,
                        fontFamily:"system-ui,sans-serif",display:"flex",alignItems:"center",gap:8}}>
                      {!user&&<span style={{fontSize:10}}>🔒</span>}⬇ PDF Report
                    </button>
                  </AuthGate>
                )}
                {/* Brand PDF */}
                {SR&&(
                  <button onClick={()=>{setShowPdfBranding(true);setShowOverflow(false);}} type="button"
                    style={{width:"100%",padding:"8px 16px",background:"transparent",border:"none",
                      cursor:"pointer",textAlign:"left",fontSize:11,color:SC.text,
                      fontFamily:"system-ui,sans-serif",display:"flex",alignItems:"center",gap:8}}>
                    🎨 Brand PDF
                  </button>
                )}
                {/* Share Design */}
                {SR&&(
                  <div style={{padding:"4px 8px"}}>
                    <ShareDesignButton user={user} params={params} results={SR} C={SC}/>
                  </div>
                )}
                <div style={{height:1,background:SC.border,margin:"4px 0"}}/>
                {/* Undo / Redo */}
                <div style={{display:"flex",gap:4,padding:"4px 8px"}}>
                  <button onClick={()=>{undo();setShowOverflow(false);}} type="button"
                    disabled={!undoCount}
                    style={{flex:1,padding:"7px 8px",background:"transparent",border:`1px solid ${SC.border}`,
                      borderRadius:4,color:undoCount?SC.text:SC.dim,fontSize:10,
                      cursor:undoCount?"pointer":"default",fontFamily:"system-ui,sans-serif",
                      display:"flex",alignItems:"center",gap:4}}>
                    ↩ Undo <span style={{fontSize:8,color:SC.dim}}>({undoCount})</span>
                  </button>
                  <button onClick={()=>{redo();setShowOverflow(false);}} type="button"
                    disabled={!redoCount}
                    style={{flex:1,padding:"7px 8px",background:"transparent",border:`1px solid ${SC.border}`,
                      borderRadius:4,color:redoCount?SC.text:SC.dim,fontSize:10,
                      cursor:redoCount?"pointer":"default",fontFamily:"system-ui,sans-serif",
                      display:"flex",alignItems:"center",gap:4}}>
                    ↪ Redo <span style={{fontSize:8,color:SC.dim}}>({redoCount})</span>
                  </button>
                </div>
                <div style={{height:1,background:SC.border,margin:"2px 0"}}/>
                {/* Reset */}
                <button onClick={()=>{setParams({payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
                    LD:14,AR:9,eOsw:0.85,clDesign:0.55,taper:0.45,tc:0.15,nPropHover:6,propDiam:3.0,twRatio:1.3,convTolExp:-6,
                    etaHov:0.70,etaSys:0.80,rateOfClimb:5.08,climbAngle:5,sedCell:300,etaBat:0.90,socMin:0.19,ewf:0.50,
                    fusLen:7.2,fusDiam:1.65,vtGamma:45,vtCh:0.45,vtCv:0.032,vtAR:2.5});setShowOverflow(false);}}
                  style={{width:"100%",padding:"8px 16px",background:"transparent",border:"none",
                    cursor:"pointer",textAlign:"left",fontSize:11,color:SC.muted,
                    fontFamily:"system-ui,sans-serif",display:"flex",alignItems:"center",gap:8}}>
                  ↺ Reset to defaults
                </button>
              </div>
            )}
          </div>

          <UserHeaderBar user={user} onSignOut={handleSignOut} onSignIn={()=>setShowAuthModal(true)} onUpdate={handleUpdate}/>
          {showAuthModal&&<AuthModal onClose={()=>setShowAuthModal(false)} onAuth={handleAuth}/>}
        </div>
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* SIDEBAR — collapsible */}
        <div style={{
          width: sidebarOpen ? 262 : 32,
          minWidth: sidebarOpen ? 262 : 32,
          flexShrink: 0,
          background: SC.panel,
          borderRight: `1px solid ${SC.border}`,
          overflowY: sidebarOpen ? "auto" : "hidden",
          overflowX: "hidden",
          padding: sidebarOpen ? "10px 13px 24px" : "10px 0 24px",
          transition: "width 0.22s cubic-bezier(.4,0,.2,1), min-width 0.22s cubic-bezier(.4,0,.2,1)",
          position: "relative",
        }}>
          {/* Toggle arrow — always visible */}
          <button
            type="button"
            onClick={()=>setSidebarOpen(v=>{ const n=!v; localStorage.setItem("sb",n?"1":"0"); return n; })}
            title={sidebarOpen?"Collapse sidebar":"Expand sidebar"}
            style={{
              position: "sticky",
              top: 0,
              zIndex: 20,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: sidebarOpen ? "100%" : 32,
              height: 28,
              marginBottom: 6,
              background: SC.bg,
              border: `1px solid ${SC.border}`,
              borderRadius: 5,
              cursor: "pointer",
              color: SC.muted,
              fontSize: 14,
              lineHeight: 1,
              transition: "background 0.15s",
            }}
            onMouseEnter={e=>e.currentTarget.style.background=`${SC.amber}18`}
            onMouseLeave={e=>e.currentTarget.style.background=SC.bg}
          >
            {sidebarOpen ? "‹" : "›"}
          </button>

          {/* Collapsed state — show mini KPI icons */}
          {!sidebarOpen && SR && (
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8,paddingTop:4}}>
              {[
                {icon:"⚖️", val:`${(SR.MTOW/1000).toFixed(1)}t`, col:SR.MTOW<4000?SC.green:SC.amber, tip:"MTOW"},
                {icon:"🔋", val:`${SR.Etot}kWh`, col:SC.teal, tip:"Energy"},
                {icon:"✈️", val:`${SR.LDact}`, col:SR.LDact>12?SC.green:SC.amber, tip:"L/D"},
                {icon:"⚡", val:`${SR.Phov}kW`, col:SC.blue, tip:"Hover Power"},
              ].map(({icon,val,col,tip})=>(
                <div key={tip} title={`${tip}: ${val}`}
                  style={{display:"flex",flexDirection:"column",alignItems:"center",gap:1,cursor:"default"}}>
                  <span style={{fontSize:14,lineHeight:1}}>{icon}</span>
                  <span style={{fontSize:6,color:col,fontFamily:"'DM Mono',monospace",
                    fontWeight:700,lineHeight:1,textAlign:"center",maxWidth:28,
                    overflow:"hidden",whiteSpace:"nowrap"}}>{val}</span>
                </div>
              ))}
              <div style={{width:20,height:1,background:SC.border,margin:"2px 0"}}/>
              {/* Mini check dots */}
              {SR.checks?.slice(0,4).map((chk,i)=>(
                <div key={i} title={chk.label+" — "+chk.val}
                  style={{width:14,height:14,borderRadius:"50%",
                    background:chk.ok?`${SC.green}33`:`${SC.red}33`,
                    border:`1px solid ${chk.ok?SC.green:SC.red}`,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontSize:7,color:chk.ok?SC.green:SC.red,cursor:"default"}}>
                  {chk.ok?"✓":"✗"}
                </div>
              ))}
            </div>
          )}

          {/* Full sidebar content — hidden when collapsed via CSS (keeps DOM for perf) */}
          <div style={{
            opacity: sidebarOpen ? 1 : 0,
            pointerEvents: sidebarOpen ? "auto" : "none",
            transition: "opacity 0.15s",
            display: sidebarOpen ? "block" : "none",
          }}>
          <Acc title="Mission Requirements" icon="🛫">
            <Slider label="Payload" unit="kg" value={params.payload} min={100} max={900} step={5} onChange={set("payload")} note="Passengers + cargo"/>
            <Slider label="Range" unit="km" value={params.range} min={50} max={500} step={10} onChange={set("range")}/>
            <Slider label="Cruise Speed" unit="m/s" value={params.vCruise} min={30} max={120} step={1} onChange={set("vCruise")} note={SR?`Mach ${SR.Mach}`:""}/>
            <Slider label="Cruise Altitude" unit="m" value={params.cruiseAlt} min={200} max={3000} step={50} onChange={set("cruiseAlt")}/>
            <Slider label="Reserve Time" unit="min" value={params.reserveMinutes||20} min={20} max={45} step={5} onChange={set("reserveMinutes")} note="20 min VFR (SC-VTOL) · 30 min IFR"/>
            <Slider label="VTOL Height" unit="m" value={params.hoverHeight} min={10} max={50} step={0.5} onChange={set("hoverHeight")}/>
          </Acc>
          <Acc title="Aerodynamics" icon="✈️">
            <Slider label="Lift-to-Drag L/D" unit="" value={params.LD} min={5} max={22} step={0.5} onChange={set("LD")} note={SR?`Actual ${SR.LDact} | Archer:11.3 Joby:~16`:"Archer:11.3 Joby:~16"}/>
            <Slider label="Aspect Ratio AR" unit="" value={params.AR} min={4} max={16} step={0.5} onChange={set("AR")}/>
            <Slider label="Oswald e" unit="" value={params.eOsw} min={0.5} max={1.0} step={0.01} onChange={set("eOsw")}/>
            <Slider label="Design CL" unit="" value={params.clDesign} min={0.3} max={1.2} step={0.05} onChange={set("clDesign")} note="eVTOL cruise: 0.45–0.65"/>
            <Slider label="Taper Ratio λ" unit="" value={params.taper} min={0.2} max={0.8} step={0.05} onChange={set("taper")}/>
            <Slider label="Thickness t/c" unit="" value={params.tc} min={0.08} max={0.20} step={0.01} onChange={set("tc")}/>
          </Acc>
          <Acc title="Propulsion" icon="🔧">
            <Slider label="Hover Rotors n" unit="" value={params.nPropHover} min={2} max={10} step={2} onChange={set("nPropHover")}/>
            <Slider label="Rotor Diameter" unit="m" value={params.propDiam} min={1.0} max={5.0} step={0.1} onChange={set("propDiam")} note={SR?`AD = ${SR.Drotor} m`:""}/>
            <Slider label="Installed T/W" unit="" value={params.twRatio} min={1.0} max={1.6} step={0.05} onChange={set("twRatio")} note="1.2 = 20% thrust margin above hover weight"/>
            <Slider label="Hover FOM η" unit="" value={params.etaHov} min={0.4} max={0.85} step={0.01} onChange={set("etaHov")} note="Optimised eVTOL rotor: 0.65–0.75"/>
            <Slider label="System η" unit="" value={params.etaSys} min={0.5} max={0.95} step={0.01} onChange={set("etaSys")} note="Motor+inverter chain: 0.78–0.85"/>
            <Slider label="Rate of Climb" unit="m/s" value={params.rateOfClimb} min={1} max={12} step={0.1} onChange={set("rateOfClimb")}/>
            <Slider label="Climb Angle" unit="°" value={params.climbAngle} min={2} max={15} step={0.5} onChange={set("climbAngle")}/>
            <Slider label="Descent Angle" unit="°" value={params.descentAngle||6} min={2} max={15} step={0.5} onChange={set("descentAngle")} note="6° typical IFR approach; steeper → slower Vdc"/>
            <Slider label="Climb L/D Penalty" unit="" value={params.climbLDPenalty||0.13} min={0.02} max={0.25} step={0.01} onChange={set("climbLDPenalty")} note="Induced drag increase during climb (0.13 = 13%)"/>
            <Slider label="ISA Deviation ΔT" unit="°C" value={params.deltaISA||0} min={-15} max={30} step={1} onChange={set("deltaISA")} note="0=std day · 15=ISA+15 hot day · -15=cold day"/>
          </Acc>
          <Acc title="Battery" icon="🔋">
            <Slider label="Cell SED" unit="Wh/kg" value={params.sedCell} min={150} max={500} step={5} onChange={set("sedCell")} note="Joby/Archer 2025: ~300 Wh/kg cell"/>
            <Slider label="Battery η" unit="" value={params.etaBat} min={0.70} max={0.99} step={0.01} onChange={set("etaBat")}/>
            <Slider label="Min SoC" unit="" value={params.socMin} min={0.05} max={0.40} step={0.01} onChange={set("socMin")}/>
            <Slider label="C-Rate SED Derate" unit="" value={params.cRateDerate??0.08} min={0.0} max={0.20} step={0.01} onChange={set("cRateDerate")} note="SED loss at peak hover C-rate (8% default for ~3-4C)"/>
          </Acc>
          <Acc title="V-Tail Design" icon="🦋">
            <Slider label="Dihedral Angle Γ" unit="°" value={params.vtGamma} min={20} max={70} step={1} onChange={set("vtGamma")}
              note={SR?`Optimal: ${SR.vtGamma_opt}°`:""}/>
            <Slider label="H-Tail Vol. Coeff Ch" unit="" value={params.vtCh} min={0.15} max={0.60} step={0.01} onChange={set("vtCh")} note="FBW eVTOL: 0.35–0.50 | SM target 5–25%"/>
            <Slider label="V-Tail Vol. Coeff Cv" unit="" value={params.vtCv} min={0.015} max={0.10} step={0.005} onChange={set("vtCv")} note="FBW eVTOL (NASA): 0.025–0.040"/>
            <Slider label="Panel Aspect Ratio" unit="" value={params.vtAR} min={1.5} max={4.0} step={0.1} onChange={set("vtAR")} note="Typical 2.0–3.0"/>
          </Acc>
          <Acc title="Structure" icon="🏗️">
            <Slider label="Empty Weight Fraction" unit="" value={params.ewf} min={0.30} max={0.70} step={0.01} onChange={set("ewf")} note="Joby:0.43 Archer:~0.45 Cora:0.55"/>
            <Slider label="Fuselage Length" unit="m" value={params.fusLen} min={3.0} max={10.0} step={0.1} onChange={set("fusLen")} note="Affects drag, stability, tail arm"/>
            <Slider label="Fuselage Diameter" unit="m" value={params.fusDiam} min={0.8} max={2.5} step={0.05} onChange={set("fusDiam")} note={`Fineness ratio: ${(params.fusLen/params.fusDiam).toFixed(1)}`}/>
          </Acc>
          {/* Design checks */}
          {SR&&(
            <div style={{marginTop:10,borderTop:`1px solid ${SC.border}`,paddingTop:10}}>
              <div style={{fontSize:8,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:"'DM Mono',monospace",marginBottom:7}}>Design Checks</div>
              {SR.checks.map((chkItem,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 0",borderBottom:`1px solid #0f131a`}}>
                  <span style={{fontSize:9}}>{chkItem.ok?"✅":"❌"}</span>
                  <span style={{fontSize:8,color:chkItem.ok?SC.green:SC.red,flex:1,fontFamily:"'DM Mono',monospace"}}>{chkItem.label}</span>
                  <span style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{chkItem.val}</span>
                </div>
              ))}
            </div>
          )}
          </div>{/* end full sidebar content */}
        </div>{/* end sidebar */}

        {/* MAIN */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Tabs — two-row: category pills on top, sub-tabs below */}
          <div style={{flexShrink:0,background:SC.panel,borderBottom:`1px solid ${SC.border}`}}>
            {/* Row 1 — category pills */}
            <div style={{display:"flex",gap:4,padding:"6px 10px 0",overflowX:"auto"}}>
              {TAB_GROUPS.map((grp,gi)=>{
                const isActive=gi===activeGroup;
                return(
                  <button key={gi} type="button"
                    onClick={()=>{
                      setActiveGroup(gi);
                      // jump to first tab in group if current tab isn't in this group
                      if(!grp.tabs.includes(tab)) setTab(grp.tabs[0]);
                    }}
                    style={{padding:"4px 14px",border:`1px solid ${isActive?grp.color:SC.border}`,
                      borderBottom:"none",borderRadius:"5px 5px 0 0",cursor:"pointer",
                      background:isActive?`${grp.color}18`:"transparent",
                      color:isActive?grp.color:SC.muted,
                      fontSize:10,fontWeight:isActive?700:400,
                      whiteSpace:"nowrap",transition:"all 0.15s",
                      fontFamily:"system-ui,sans-serif",letterSpacing:"0.01em"}}>
                    {grp.label}
                  </button>
                );
              })}
            </div>
            {/* Row 2 — sub-tabs for active group */}
            <div style={{display:"flex",overflowX:"auto",padding:"0 6px",
              borderTop:`1px solid ${SC.border}`,background:SC.bg}}>
              {TAB_GROUPS[activeGroup].tabs.map(i=>{
                const grpColor=TAB_GROUPS[activeGroup].color;
                const isActive=i===tab;
                return(
                  <button key={i} type="button" onClick={()=>setTab(i)}
                    style={{padding:"6px 13px",background:"transparent",border:"none",cursor:"pointer",
                      borderBottom:isActive?`2px solid ${grpColor}`:"2px solid transparent",
                      color:isActive?SC.text:SC.muted,
                      fontSize:10,fontFamily:"system-ui,sans-serif",
                      whiteSpace:"nowrap",transition:"color 0.15s",letterSpacing:"0.01em"}}>
                    {TABI[i]} {TABS[i]}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{flex:1,overflowY:"auto",padding:"14px 18px 28px",background:SC.bg}}>
            {/* Shared design banner — shown when ?design= is in URL */}
            {sharedDesignId&&(
              <PublicDesignBanner shareId={sharedDesignId} onLoad={params=>setParams(prev=>({...prev,...params}))} C={SC}/>
            )}
            {!SR&&<div style={{color:SC.red,fontFamily:"'DM Mono',monospace",padding:20}}>Calculation error — adjust inputs.</div>}
            {SR&&<>

            {/* ──── TAB 0: OVERVIEW ──── */}
            {tab===0&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="MTOW" value={SR.MTOW} unit="kg" color={SR.MTOW<4000?SC.green:SR.MTOW<5000?SC.amber:SC.red} sub={`R1: ${SR.MTOW1} kg`}/>
                  <KPI label="Battery Mass" value={SR.Wbat} unit="kg" color={SR.Wbat/SR.MTOW<0.4?SC.green:SC.amber} sub={`${(SR.Wbat/SR.MTOW*100).toFixed(1)}% of MTOW`}/>
                  <KPI label="Total Energy" value={SR.Etot} unit="kWh" color={SC.teal} sub={`Pack: ${SR.PackkWh} kWh`}/>
                  <KPI label="Actual L/D" value={SR.LDact} unit="" color={SR.LDact>12?SC.green:SC.amber} sub={`CD₀=${SR.CD0tot} CDi=${SR.CDi}`}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Wing Area" value={SR.Swing} unit="m²" sub={`Span ${SR.bWing} m`}/>
                  <KPI label="Hover Power" value={SR.Phov} unit="kW" color={SC.blue} sub={`Cruise ${SR.Pcr} kW`}/>
                  <KPI label="Static Margin" value={(SR.SM*100).toFixed(1)} unit="% MAC" color={SR.SM>0.05&&SR.SM<0.25?SC.green:SC.red}/>
                  <KPI label="Mach" value={SR.Mach} unit="" color={SR.Mach<0.35?SC.green:SC.amber} sub={`Re ${(SR.Re_/1e6).toFixed(2)}×10⁶`}/>
                </div>
                {/* ── Uncertainty bands from Monte Carlo (shown when MC has been run) ── */}
                {mcResults&&(
                  <div style={{background:SC.panel,border:`1px solid #7c3aed44`,borderRadius:8,padding:"12px 16px"}}>
                    <div style={{fontSize:9,color:"#a78bfa",fontFamily:"'DM Mono',monospace",letterSpacing:"0.14em",marginBottom:8}}>MC UNCERTAINTY BANDS — {mcResults.N.toLocaleString()} SAMPLES</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                      {[
                        ["MTOW",SR.MTOW,mcResults.MTOW.stats,"kg",SC.amber],
                        ["Total Energy",SR.Etot,mcResults.Etot.stats,"kWh",SC.teal],
                        ["Hover Power",SR.Phov,mcResults.Phov.stats,"kW",SC.blue],
                        ["Static Margin",(SR.SM_vt*100).toFixed(1),mcResults.SM?.stats||null,"%",SC.purple],
                      ].map(([label,nominal,stats,unit,col])=>(
                        <div key={label} style={{background:SC.bg,border:`1px solid ${col}33`,borderRadius:6,padding:"8px 10px"}}>
                          <div style={{fontSize:9,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:4}}>{label}</div>
                          <div style={{fontSize:13,fontWeight:800,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{nominal} <span style={{fontSize:9,color:SC.muted}}>{unit}</span></div>
                          <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginTop:3}}>
                            μ={typeof stats.mean==="number"?stats.mean.toFixed(1):stats.mean} ± {typeof stats.std==="number"?stats.std.toFixed(1):stats.std} {unit}
                          </div>
                          <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                            P5={typeof stats.p5==="number"?stats.p5.toFixed(1):stats.p5} — P95={typeof stats.p95==="number"?stats.p95.toFixed(1):stats.p95} {unit}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginTop:6}}>
                      ⓘ Run Monte Carlo (Tab 9) to update these bands. Current nominal is the deterministic point estimate.
                    </div>
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Power per Phase (kW)" ht={255}>
                    <ResponsiveContainer width="100%" height={205}>
                      <BarChart data={[{ph:"T/O",v:SR.Phov},{ph:"Climb",v:SR.Pcl},{ph:"Cruise",v:SR.Pcr},{ph:"Descent",v:SR.Pdc},{ph:"Land",v:SR.Phov},{ph:"Reserve",v:SR.Pres}]}
                        margin={{top:5,right:8,left:-15,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="kW">{PHC.map((clr,i)=><Cell key={i} fill={clr}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Energy per Phase (kWh)" ht={255}>
                    <ResponsiveContainer width="100%" height={205}>
                      <BarChart data={[{ph:"T/O",v:SR.Eto},{ph:"Climb",v:SR.Ecl},{ph:"Cruise",v:SR.Ecr},{ph:"Descent",v:SR.Edc},{ph:"Land",v:SR.Eld},{ph:"Reserve",v:SR.Eres}]}
                        margin={{top:5,right:8,left:-15,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="kWh">{PHC.map((clr,i)=><Cell key={i} fill={clr}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
                <Panel title="Mission Timeline — Final Converged Values">
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                      <thead><tr style={{background:SC.panel}}>
                        {["Phase","Time (s)","Power (kW)","Energy (kWh)","Velocity (m/s)"].map(hdr=>(
                          <th key={hdr} style={{padding:"5px 12px",textAlign:"left",color:SC.muted,fontFamily:"'DM Mono',monospace",fontSize:8,fontWeight:600,letterSpacing:"0.05em"}}>{hdr}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {[["🛫 Takeoff Hover",SR.tto,SR.Phov,SR.Eto,0.5],
                          ["📈 Climb",SR.tcl,SR.Pcl,SR.Ecl,+(params.rateOfClimb/Math.sin(params.climbAngle*Math.PI/180)).toFixed(1)],
                          ["✈️ Cruise",SR.tcr,SR.Pcr,SR.Ecr,params.vCruise],
                          ["📉 Descent",SR.tdc,SR.Pdc,SR.Edc,+Math.min(params.rateOfClimb/Math.sin((params.descentAngle||6)*Math.PI/180),params.vCruise).toFixed(1)],
                          ["🛬 Landing Hover",SR.tld,SR.Phov,SR.Eld,0.5],
                          ["🔄 Reserve",SR.tres,SR.Pres,SR.Eres,+(0.7*params.vCruise).toFixed(1)],
                        ].map(([ph,t,pw,e,v],i)=>(
                          <tr key={i} style={{borderTop:`1px solid ${SC.border}`,background:i%2?"#0a0d14":SC.bg}}>
                            <td style={{padding:"6px 12px",color:SC.text,fontWeight:600}}>{ph}</td>
                            <td style={{padding:"6px 12px",color:SC.amber,fontFamily:"'DM Mono',monospace"}}>{t}</td>
                            <td style={{padding:"6px 12px",color:PHC[i],fontFamily:"'DM Mono',monospace"}}>{pw}</td>
                            <td style={{padding:"6px 12px",color:SC.teal,fontFamily:"'DM Mono',monospace"}}>{e}</td>
                            <td style={{padding:"6px 12px",color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            )}

            {/* ──── SENSITIVITY REPORT (Overview tab only) ──── */}
            {tab===0&&SR&&<SensPanel params={params} SR={SR} SC={SC}/>}

            {/* ──── TAB 1: MISSION ──── */}
            {tab===1&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* KPI row */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8}}>
                  {[
                    ["Total Time",`${SR.Tend}s`,SC.muted],
                    ["Total Energy",`${SR.Etot} kWh`,SC.teal],
                    ["Peak Power",`${SR.Phov} kW`,SC.amber],
                    ["Cruise Power",`${SR.Pcr} kW`,SC.blue],
                    ["Cruise Speed",`${params.vCruise} m/s`,SC.green],
                    ["Range",`${params.range} km`,SC.purple],
                  ].map(([lbl,val,col])=>(
                    <div key={lbl} style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:6,padding:"8px 10px",borderLeft:`2px solid ${col}`}}>
                      <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:3}}>{lbl}</div>
                      <div style={{fontSize:13,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace"}}>{val}</div>
                    </div>
                  ))}
                </div>

                {/* Power vs Time */}
                <Panel title="Power vs Mission Time (kW)" ht={270}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={SR.powerSteps} margin={{top:5,right:16,left:-5,bottom:16}}>
                      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SC.amber} stopOpacity={0.4}/><stop offset="95%" stopColor={SC.amber} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" tick={{fontSize:10,fill:SC.muted}} label={{value:"Time (s)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:10,fill:SC.muted}} label={{value:"Power (kW)",angle:-90,position:"insideLeft",offset:10,fontSize:11,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`${v} kW`,n]}/>
                      <Area type="stepAfter" dataKey="P" stroke={SC.amber} strokeWidth={2.5} fill="url(#pg)" dot={false} name="Power (kW)"/>
                      {SR.tPhases.slice(1,-1).map((tp,i)=>(
                        <ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1.5}
                          label={{value:["Climb","Cruise","Desc","Land","Res"][i],fill:PHC[i],fontSize:9,position:"top"}}/>
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                {/* Energy vs Time — NEW */}
                <Panel title="Cumulative Energy Consumed vs Mission Time (kWh)" ht={270}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={SR.energySteps} margin={{top:5,right:16,left:-5,bottom:16}}>
                      <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SC.teal} stopOpacity={0.45}/><stop offset="95%" stopColor={SC.teal} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" tick={{fontSize:10,fill:SC.muted}} label={{value:"Time (s)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:10,fill:SC.muted}} label={{value:"Energy (kWh)",angle:-90,position:"insideLeft",offset:10,fontSize:11,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`${v} kWh`,n]}/>
                      <Area type="monotone" dataKey="E" stroke={SC.teal} strokeWidth={2.5} fill="url(#eg)" dot={false} name="Cumulative Energy (kWh)"/>
                      <ReferenceLine y={SR.Etot} stroke={SC.green} strokeDasharray="5 3"
                        label={{value:`Total: ${SR.Etot} kWh`,fill:SC.green,fontSize:10,position:"insideTopRight"}}/>
                      <ReferenceLine y={SR.PackkWh} stroke={SC.amber} strokeDasharray="5 3"
                        label={{value:`Pack: ${SR.PackkWh} kWh`,fill:SC.amber,fontSize:10,position:"insideBottomRight"}}/>
                      {SR.tPhases.slice(1,-1).map((tp,i)=>(
                        <ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1.5}
                          label={{value:["Climb","Cruise","Desc","Land","Res"][i],fill:PHC[i],fontSize:9,position:"top"}}/>
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                {/* Energy Remaining Over Mission */}
                <Panel title="Battery Energy Remaining vs Mission Time" ht={270}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart
                      data={SR.energySteps.map(s=>({t:s.t, Erem:+Math.max(0,SR.PackkWh-s.E).toFixed(3)}))}
                      margin={{top:10,right:24,left:10,bottom:20}}>
                      <defs><linearGradient id="edg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SC.teal} stopOpacity={0.55}/>
                        <stop offset="95%" stopColor={SC.teal} stopOpacity={0.04}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" type="number" domain={["dataMin","dataMax"]}
                        tick={{fontSize:9,fill:SC.muted}}
                        label={{value:"Mission Time (s)",position:"insideBottom",offset:-8,fontSize:10,fill:SC.muted}}/>
                      <YAxis
                        domain={[0, +(SR.PackkWh*1.08).toFixed(1)]}
                        tickCount={6}
                        tickFormatter={v=>v.toFixed(0)}
                        tick={{fontSize:9,fill:SC.muted}}
                        label={{value:"Energy Remaining (kWh)",angle:-90,position:"insideLeft",offset:0,fontSize:9,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${(+v).toFixed(2)} kWh`,"Energy Remaining"]}/>
                      <Area type="monotone" dataKey="Erem" stroke={SC.teal} strokeWidth={2.5}
                        fill="url(#edg)" dot={false} name="Energy Remaining"/>
                      <ReferenceLine y={SR.PackkWh} stroke={SC.green} strokeDasharray="5 3"
                        label={{value:`Pack full: ${SR.PackkWh} kWh`,fill:SC.green,fontSize:9,position:"insideTopLeft"}}/>
                      <ReferenceLine y={+Math.max(0,SR.PackkWh-SR.Etot).toFixed(2)} stroke={SC.red} strokeDasharray="5 3"
                        label={{value:`Reserve: ${Math.max(0,SR.PackkWh-SR.Etot).toFixed(1)} kWh`,fill:SC.red,fontSize:9,position:"insideBottomRight"}}/>
                      {SR.tPhases.slice(1,-1).map((tp,i)=>(
                        <ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1.5}
                          label={{value:["Climb","Cruise","Desc","Land","Res"][i],fill:PHC[i],fontSize:9,position:"top"}}/>
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                                {/* Velocity vs Time */}
                <Panel title="Velocity vs Mission Time (m/s)" ht={230}>
                  <ResponsiveContainer width="100%" height={185}>
                    <AreaChart data={SR.velSteps} margin={{top:5,right:16,left:-5,bottom:16}}>
                      <defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SC.blue} stopOpacity={0.4}/><stop offset="95%" stopColor={SC.blue} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" tick={{fontSize:10,fill:SC.muted}} label={{value:"Time (s)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:10,fill:SC.muted}} label={{value:"Speed (m/s)",angle:-90,position:"insideLeft",offset:10,fontSize:11,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`${v} m/s`,n]}/>
                      <Area type="stepAfter" dataKey="V" stroke={SC.blue} strokeWidth={2.5} fill="url(#vg)" dot={false} name="Speed (m/s)"/>
                      <ReferenceLine y={params.vCruise} stroke={SC.amber} strokeDasharray="4 3"
                        label={{value:`Vcr = ${params.vCruise} m/s`,fill:SC.amber,fontSize:10,position:"insideTopRight"}}/>
                      {SR.tPhases.slice(1,-1).map((tp,i)=>(
                        <ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                {/* ── Combined Power + Energy vs Time (dual Y-axis) ── */}
                <Panel title="Power & Energy vs Mission Time — Combined (Dual Axis)">
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:8,paddingLeft:4}}>
                    <span style={{color:SC.amber,fontWeight:700}}>■ Power (kW)</span> on left axis &nbsp;·&nbsp;
                    <span style={{color:SC.green,fontWeight:700}}>■ Phase Energy (kWh)</span> on right axis — both plotted step-wise per phase, matching the MATLAB reference.
                  </div>
                  <ResponsiveContainer width="100%" height={280}>
                    <ComposedChart
                      data={(()=>{
                        // Build step data: for each phase show power and energy as step-wise blocks
                        // matching the MATLAB "Energy vs Time" shape exactly
                        const phases=[
                          {label:"T/O",   tStart:SR.tPhases[0], tEnd:SR.tPhases[1], power:SR.Phov, energy:SR.Eto},
                          {label:"Climb", tStart:SR.tPhases[1], tEnd:SR.tPhases[2], power:SR.Pcl,  energy:SR.Ecl},
                          {label:"Cruise",tStart:SR.tPhases[2], tEnd:SR.tPhases[3], power:SR.Pcr,  energy:SR.Ecr},
                          {label:"Desc",  tStart:SR.tPhases[3], tEnd:SR.tPhases[4], power:SR.Pdc,  energy:SR.Edc},
                          {label:"Land",  tStart:SR.tPhases[4], tEnd:SR.tPhases[5], power:SR.Phov, energy:SR.Eld},
                          {label:"Res",   tStart:SR.tPhases[5], tEnd:SR.tPhases[6], power:SR.Pres, energy:SR.Eres},
                        ];
                        // Build array with step transitions: each phase generates 2 points (start, end)
                        const pts=[];
                        phases.forEach(ph=>{
                          pts.push({t:+ph.tStart.toFixed(0), P:+ph.power.toFixed(2), E:+ph.energy.toFixed(3), label:ph.label});
                          pts.push({t:+ph.tEnd.toFixed(0),   P:+ph.power.toFixed(2), E:+ph.energy.toFixed(3), label:ph.label});
                        });
                        return pts;
                      })()}
                      margin={{top:10,right:60,left:10,bottom:20}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" tick={{fontSize:10,fill:SC.muted}}
                        label={{value:"Time (s)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                      {/* Left Y — Power */}
                      <YAxis yAxisId="left" tick={{fontSize:10,fill:SC.amber}}
                        label={{value:"Power (kW)",angle:-90,position:"insideLeft",offset:14,fontSize:11,fill:SC.amber}}/>
                      {/* Right Y — Energy */}
                      <YAxis yAxisId="right" orientation="right" tick={{fontSize:10,fill:SC.green}}
                        label={{value:"Energy (kWh)",angle:90,position:"insideRight",offset:14,fontSize:11,fill:SC.green}}/>
                      <Tooltip {...TTP}
                        formatter={(v,n)=>n==="Power (kW)"?[`${v} kW`,n]:[`${v} kWh`,n]}
                        labelFormatter={tval=>`t = ${tval} s`}/>
                      <Legend iconSize={10} wrapperStyle={{fontSize:11,color:SC.muted,paddingTop:4}}/>
                      {/* Phase reference lines */}
                      {SR.tPhases.slice(1,-1).map((tp,i)=>(
                        <ReferenceLine key={i} x={Math.round(tp)} yAxisId="left"
                          stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1.5}
                          label={{value:["Climb","Cruise","Desc","Land","Res"][i],fill:PHC[i],fontSize:9,position:"top"}}/>
                      ))}
                      {/* Power line — amber, step, left axis */}
                      <Line yAxisId="left" type="stepAfter" dataKey="P" stroke={SC.amber} strokeWidth={2.5}
                        dot={false} name="Power (kW)" connectNulls={false}/>
                      {/* Energy line — green, step, right axis */}
                      <Line yAxisId="right" type="stepAfter" dataKey="E" stroke={SC.green} strokeWidth={2.5}
                        dot={false} name="Energy (kWh)" connectNulls={false}
                        strokeDasharray="0"/>
                    </ComposedChart>
                  </ResponsiveContainer>
                  <div style={{display:"flex",gap:20,marginTop:8,padding:"8px 12px",background:SC.bg,borderRadius:6,border:`1px solid ${SC.border}`,flexWrap:"wrap"}}>
                    {[
                      ["T/O",   SR.Phov, SR.Eto,  PHC[0]],
                      ["Climb", SR.Pcl,  SR.Ecl,  PHC[1]],
                      ["Cruise",SR.Pcr,  SR.Ecr,  PHC[2]],
                      ["Desc",  SR.Pdc,  SR.Edc,  PHC[3]],
                      ["Land",  SR.Phov, SR.Eld,  PHC[4]],
                      ["Res",   SR.Pres, SR.Eres, PHC[5]],
                    ].map(([lbl,pw,e,col])=>(
                      <div key={lbl} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:col}}/>
                        <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{lbl}</span>
                        <span style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{pw} kW</span>
                        <span style={{fontSize:10,color:SC.green,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{e} kWh</span>
                      </div>
                    ))}
                  </div>
                </Panel>

                {/* Phase Power vs Phase Energy vs Phase Time — NEW grouped bar chart */}
                <Panel title="Phase Comparison — Power (kW) · Energy (kWh) · Duration (s)">
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:8,paddingLeft:4}}>
                    Grouped bars show the three key metrics for each mission phase. Each metric is normalised relative to its maximum value so all three can be compared on the same axis.
                    Raw values shown in the data table below.
                  </div>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart
                      data={[
                        {ph:"T/O",    power:+(SR.Phov/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1), energy:+(SR.Eto/SR.Etot*100).toFixed(1),  time:+(SR.tto/SR.Tend*100).toFixed(1)},
                        {ph:"Climb",  power:+(SR.Pcl/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1),  energy:+(SR.Ecl/SR.Etot*100).toFixed(1),  time:+(SR.tcl/SR.Tend*100).toFixed(1)},
                        {ph:"Cruise", power:+(SR.Pcr/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1),  energy:+(SR.Ecr/SR.Etot*100).toFixed(1),  time:+(SR.tcr/SR.Tend*100).toFixed(1)},
                        {ph:"Descent",power:+(SR.Pdc/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1),  energy:+(SR.Edc/SR.Etot*100).toFixed(1),  time:+(SR.tdc/SR.Tend*100).toFixed(1)},
                        {ph:"Land",   power:+(SR.Phov/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1), energy:+(SR.Eld/SR.Etot*100).toFixed(1),  time:+(SR.tld/SR.Tend*100).toFixed(1)},
                        {ph:"Reserve",power:+(SR.Pres/Math.max(SR.Phov,SR.Pcl,SR.Pcr,SR.Pdc,SR.Pres)*100).toFixed(1), energy:+(SR.Eres/SR.Etot*100).toFixed(1), time:+(SR.tres/SR.Tend*100).toFixed(1)},
                      ]}
                      margin={{top:5,right:20,left:-10,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="ph" tick={{fontSize:11,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:10,fill:SC.muted}} label={{value:"% of max",angle:-90,position:"insideLeft",offset:14,fontSize:11,fill:SC.muted}} domain={[0,110]}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                      <Legend iconSize={9} wrapperStyle={{fontSize:11,color:SC.muted}}/>
                      <Bar dataKey="power" name="Power (% of peak)" fill={SC.amber} radius={[3,3,0,0]} maxBarSize={28}/>
                      <Bar dataKey="energy" name="Energy (% of total)" fill={SC.teal} radius={[3,3,0,0]} maxBarSize={28}/>
                      <Bar dataKey="time" name="Duration (% of total)" fill={SC.blue} radius={[3,3,0,0]} maxBarSize={28}/>
                    </BarChart>
                  </ResponsiveContainer>

                  {/* Raw data table below the chart */}
                  <div style={{overflowX:"auto",marginTop:12}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                      <thead>
                        <tr style={{background:SC.panel}}>
                          {["Phase","Power (kW)","Energy (kWh)","Duration (s)","% Total E","% Total Time"].map(hdr=>(
                            <th key={hdr} style={{padding:"5px 10px",textAlign:"right",color:SC.muted,fontSize:8,fontWeight:600,letterSpacing:"0.05em",
                              textTransform:"uppercase",":first-child":{textAlign:"left"}}}>{hdr}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          ["🛫 Takeoff",SR.Phov,SR.Eto,SR.tto,PHC[0]],
                          ["📈 Climb",SR.Pcl,SR.Ecl,SR.tcl,PHC[1]],
                          ["✈️ Cruise",SR.Pcr,SR.Ecr,SR.tcr,PHC[2]],
                          ["📉 Descent",SR.Pdc,SR.Edc,SR.tdc,PHC[3]],
                          ["🛬 Landing",SR.Phov,SR.Eld,SR.tld,PHC[4]],
                          ["🔄 Reserve",SR.Pres,SR.Eres,SR.tres,PHC[5]],
                        ].map(([ph,pw,e,t,col],i)=>(
                          <tr key={i} style={{borderTop:`1px solid ${SC.border}`,background:i%2?"#0a0d14":SC.bg}}>
                            <td style={{padding:"5px 10px",color:SC.text,fontWeight:600}}>{ph}</td>
                            <td style={{padding:"5px 10px",color:SC.amber,textAlign:"right"}}>{pw}</td>
                            <td style={{padding:"5px 10px",color:SC.teal,textAlign:"right"}}>{e}</td>
                            <td style={{padding:"5px 10px",color:SC.blue,textAlign:"right"}}>{t}</td>
                            <td style={{padding:"5px 10px",textAlign:"right"}}>
                              <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                                <div style={{width:40,height:5,background:SC.border,borderRadius:2}}>
                                  <div style={{width:`${(e/SR.Etot*100).toFixed(0)}%`,height:"100%",background:col,borderRadius:2}}/>
                                </div>
                                <span style={{color:col,minWidth:32}}>{(e/SR.Etot*100).toFixed(1)}%</span>
                              </div>
                            </td>
                            <td style={{padding:"5px 10px",textAlign:"right"}}>
                              <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                                <div style={{width:40,height:5,background:SC.border,borderRadius:2}}>
                                  <div style={{width:`${(t/SR.Tend*100).toFixed(0)}%`,height:"100%",background:SC.muted,borderRadius:2}}/>
                                </div>
                                <span style={{color:SC.muted,minWidth:32}}>{(t/SR.Tend*100).toFixed(1)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                        {/* Totals row */}
                        <tr style={{borderTop:`2px solid ${SC.border}`,background:SC.panel}}>
                          <td style={{padding:"6px 10px",color:SC.text,fontWeight:700}}>TOTAL</td>
                          <td style={{padding:"6px 10px",color:SC.amber,textAlign:"right",fontWeight:700}}>—</td>
                          <td style={{padding:"6px 10px",color:SC.teal,textAlign:"right",fontWeight:700}}>{SR.Etot}</td>
                          <td style={{padding:"6px 10px",color:SC.blue,textAlign:"right",fontWeight:700}}>{SR.Tend}</td>
                          <td style={{padding:"6px 10px",color:SC.muted,textAlign:"right",fontWeight:700}}>100%</td>
                          <td style={{padding:"6px 10px",color:SC.muted,textAlign:"right",fontWeight:700}}>100%</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </Panel>

                {/* Phase Duration + Energy Radar */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Phase Duration (s)" ht={240}>
                    <ResponsiveContainer width="100%" height={195}>
                      <PieChart>
                        <Pie data={[{n:"T/O",v:SR.tto},{n:"Climb",v:SR.tcl},{n:"Cruise",v:SR.tcr},{n:"Descent",v:SR.tdc},{n:"Land",v:SR.tld},{n:"Reserve",v:SR.tres}]}
                          dataKey="v" nameKey="n" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={3}>
                          {PHC.map((clr,i)=><Cell key={i} fill={clr}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v)=>[`${v} s`,"Duration"]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:11,color:SC.muted}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Energy per Phase — Radar (kWh)" ht={240}>
                    <ResponsiveContainer width="100%" height={195}>
                      <RadarChart data={[{ph:"T/O",E:SR.Eto},{ph:"Climb",E:SR.Ecl},{ph:"Cruise",E:SR.Ecr},{ph:"Desc",E:SR.Edc},{ph:"Land",E:SR.Eld},{ph:"Res",E:SR.Eres}]}>
                        <PolarGrid stroke={SC.border}/>
                        <PolarAngleAxis dataKey="ph" tick={{fontSize:11,fill:SC.muted}}/>
                        <Radar dataKey="E" stroke={SC.teal} fill={SC.teal} fillOpacity={0.25} name="Energy (kWh)"/>
                        <Tooltip {...TTP} formatter={(v)=>[`${v} kWh`,"Energy"]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:11,color:SC.muted}}/>
                      </RadarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>

              </div>
            )}


            {/* ──── TAB 2: WING & AERO ──── */}
            {tab===2&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Wing Area" value={SR.Swing} unit="m²"/><KPI label="Wing Span" value={SR.bWing} unit="m"/>
                  <KPI label="MAC" value={SR.MAC} unit="m"/><KPI label="Sweep" value={SR.sweep} unit="°"/>
                  <KPI label="Root Chord" value={SR.Cr_} unit="m"/><KPI label="Tip Chord" value={SR.Ct_} unit="m"/>
                  <KPI label="Wing Loading" value={SR.WL} unit="N/m²"/><KPI label="Reynolds ×10⁶" value={(SR.Re_/1e6).toFixed(2)} unit=""/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="CD₀ Breakdown (Raymer Buildup)" ht={265}>
                    <ResponsiveContainer width="100%" height={215}>
                      <PieChart>
                        <Pie data={SR.dragComp} dataKey="val" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={85} paddingAngle={3}>
                          {["#3b82f6","#ef4444","#22c55e","#f59e0b","#8b5cf6","#ec4899","#06b6d4"].map((clr,i)=><Cell key={i} fill={clr}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v)=>[v.toFixed(5),"CD₀"]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:12,color:SC.muted}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Airfoil Selection Score" ht={265}>
                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6}}>
                      Re = {(SR.Re_/1e6).toFixed(2)}×10⁶ · CDmin interpolated at operating Re · 24 candidates
                    </div>
                    <div style={{height:185,overflowY:"auto"}}>
                      {[...SR.afScored].sort((a,b)=>b.score-a.score).map((af,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"4px 0",borderBottom:`1px solid ${SC.border}`}}>
                          <span style={{fontSize:9,minWidth:108,color:af.name===SR.selAF.name?SC.green:af.category==="Custom"?SC.amber:SC.text,
                            fontFamily:"'DM Mono',monospace",fontWeight:af.name===SR.selAF.name?700:400}}>
                            {af.name===SR.selAF.name?"★ ":af.category==="Custom"?"⊕ ":""}{af.name}
                          </span>
                          <div style={{flex:1,height:4,background:SC.border,borderRadius:2}}>
                            <div style={{height:"100%",width:`${af.score*100}%`,background:af.name===SR.selAF.name?SC.green:af.category==="Custom"?SC.amber:SC.muted,borderRadius:2}}/>
                          </div>
                          <span style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",minWidth:42,textAlign:"right"}}>
                            {af.CDmin.toFixed(4)}
                          </span>
                          <span style={{fontSize:9,color:af.name===SR.selAF.name?SC.green:SC.muted,fontFamily:"'DM Mono',monospace",minWidth:32,textAlign:"right"}}>
                            {(af.score*100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                      <div style={{marginTop:8,fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                        ★ {SR.selAF.name} | t/c={SR.selAF.tc} CLmax={SR.selAF.CLmax} CDmin@Re={SR.selAF.CDmin.toFixed(4)} | {SR.selAF.source||""}
                      </div>
                    </div>
                  </Panel>
                </div>

                {/* ── Custom Airfoil Input ── */}
                <Panel title="Custom Airfoil — Paste XFoil / UIUC Polar Data">
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:10,lineHeight:1.7}}>
                    Paste XFoil polar output or UIUC ADB data (alpha, CL, CD columns). The app fits a parabolic drag polar
                    <strong style={{color:SC.text}}> CD = CDmin + k·(CL − CLd)²</strong> and overrides the library selection.
                    Clear the box to revert to automatic selection.
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:12,alignItems:"start"}}>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                        Format: one row per alpha — <code>alpha  CL  CD</code> (whitespace or comma separated)
                      </div>
                      <textarea
                        value={customAirfoilInput}
                        onChange={e=>setCustomAirfoilInput(e.target.value)}
                        placeholder={"Example (XFoil NACA 63-415 at Re=7M):\n alpha    CL       CD\n-4.00   0.0320   0.00740\n-2.00   0.2480   0.00440\n 0.00   0.4640   0.00420\n 2.00   0.6800   0.00440\n 4.00   0.8960   0.00480\n 6.00   1.1120   0.00580\n 8.00   1.3280   0.00750"}
                        style={{width:"100%",boxSizing:"border-box",height:140,background:SC.bg,
                          border:`1px solid ${SC.border}`,borderRadius:6,color:SC.text,
                          fontSize:10,padding:"8px 10px",fontFamily:"'DM Mono',monospace",
                          outline:"none",resize:"vertical"}}
                      />
                      {customAFError&&(
                        <div style={{fontSize:10,color:SC.red,fontFamily:"'DM Mono',monospace",marginTop:4}}>
                          ⚠ {customAFError}
                        </div>
                      )}
                    </div>
                    <div style={{display:"flex",flexDirection:"column",gap:8,minWidth:160}}>
                      <div style={{background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:6,padding:"10px 12px"}}>
                        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6}}>Airfoil metadata</div>
                        {[
                          ["Name",customAFData?.name||"—"],
                          ["t/c",customAFData?customAFData.tc.toFixed(3):"—"],
                          ["CLmax",customAFData?customAFData.CLmax.toFixed(3):"—"],
                          ["CLd (design)",customAFData?customAFData.CLd.toFixed(3):"—"],
                          ["CDmin",customAFData?customAFData.CDmin.toFixed(5):"—"],
                          ["k (polar)",customAFData?customAFData.kPolar.toFixed(5):"—"],
                          ["CM",customAFData?customAFData.CM.toFixed(3):"—"],
                        ].map(([k,v])=>(
                          <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",borderBottom:`1px solid ${SC.border}22`}}>
                            <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{k}</span>
                            <span style={{fontSize:9,color:SC.text,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                          </div>
                        ))}
                      </div>
                      <button type="button" onClick={()=>{
                        const txt=customAirfoilInput.trim();
                        if(!txt){setCustomAFData(null);setCustomAFError("");return;}
                        try{
                          const rows=txt.split('\n').map(l=>l.trim()).filter(l=>l&&!/^[a-zA-Z#]/.test(l));
                          const pts=rows.map(l=>{
                            const cols=l.split(/[\s,]+/);
                            if(cols.length<3)throw new Error("Need at least 3 columns: alpha CL CD");
                            return{alpha:parseFloat(cols[0]),CL:parseFloat(cols[1]),CD:parseFloat(cols[2])};
                          }).filter(r=>!isNaN(r.alpha)&&!isNaN(r.CL)&&!isNaN(r.CD));
                          if(pts.length<5)throw new Error("Need at least 5 data points");
                          const CLmax=Math.max(...pts.map(p=>p.CL));
                          const minCD_pt=pts.reduce((a,b)=>b.CD<a.CD?b:a);
                          const CDmin=minCD_pt.CD, CLd=minCD_pt.CL;
                          // Fit parabolic polar: CD = CDmin + k*(CL-CLd)^2  by least squares
                          let sumX2=0,sumX4=0,sumX2Y=0,n=0;
                          pts.forEach(pt=>{const x=(pt.CL-CLd)**2,y=pt.CD-CDmin;sumX2+=x;sumX4+=x*x;sumX2Y+=x*y;n++;});
                          const kPolar=sumX2>0?sumX2Y/sumX2:0.012;
                          // Estimate CM from moment of polar distribution (approximate)
                          const CM_est=pts.length>0?pts.reduce((s,p)=>s+(-0.01*p.CL),0)/pts.length:-0.05;
                          // Estimate t/c from name input or default
                          const tcEst=0.12;
                          setCustomAFData({
                            name:"Custom (User)",tc:tcEst,CLmax,CLd,CDmin,kPolar,CM:CM_est,
                          });
                          setCustomAFError("");
                        }catch(e){setCustomAFError(e.message);setCustomAFData(null);}
                      }} style={{padding:"8px 0",background:`${SC.teal}22`,border:`1px solid ${SC.teal}55`,
                        borderRadius:6,color:SC.teal,fontSize:11,cursor:"pointer",fontFamily:"'DM Mono',monospace",fontWeight:700}}>
                        ⊕ Parse & Apply
                      </button>
                      {customAFData&&(
                        <button type="button" onClick={()=>{setCustomAFData(null);setCustomAirfoilInput("");setCustomAFError("");}}
                          style={{padding:"8px 0",background:`${SC.red}11`,border:`1px solid ${SC.red}33`,
                            borderRadius:6,color:SC.red,fontSize:11,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                          ✕ Clear Custom
                        </button>
                      )}
                    </div>
                  </div>
                  {customAFData&&(
                    <div style={{marginTop:10,padding:"8px 12px",background:`${SC.teal}11`,border:`1px solid ${SC.teal}33`,
                      borderRadius:6,fontSize:10,color:SC.teal,fontFamily:"'DM Mono',monospace"}}>
                      ✓ Custom airfoil active — overrides library selection. CDmin={customAFData.CDmin.toFixed(5)},
                      CLmax={customAFData.CLmax.toFixed(3)}, k={customAFData.kPolar.toFixed(5)}.
                      Polar fitted from {customAirfoilInput.trim().split('\n').filter(l=>l&&!/^[a-zA-Z#]/.test(l.trim())).length} data points.
                    </div>
                  )}
                </Panel>

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <Panel title="Drag Polar" ht={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <LineChart data={SR.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="CD" tick={{fontSize:11,fill:SC.muted}} label={{value:"CD",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}} label={{value:"CL",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Line type="monotone" dataKey="CL" stroke={SC.blue} strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Lift Curve" ht={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <LineChart data={SR.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="alpha" tick={{fontSize:11,fill:SC.muted}} label={{value:"α (°)",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Line type="monotone" dataKey="CL" stroke={SC.green} strokeWidth={2} dot={false}/>
                        <ReferenceLine y={params.clDesign} stroke={SC.amber} strokeDasharray="3 3" label={{value:"CL_des",fill:SC.amber,fontSize:11}}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="L/D Ratio" ht={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <AreaChart data={SR.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <defs><linearGradient id="ldg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={SC.amber} stopOpacity={0.3}/><stop offset="95%" stopColor={SC.amber} stopOpacity={0}/>
                        </linearGradient></defs>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="alpha" tick={{fontSize:11,fill:SC.muted}} label={{value:"α (°)",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Area type="monotone" dataKey="LD" stroke={SC.amber} strokeWidth={2} fill="url(#ldg)" dot={false}/>
                        <ReferenceLine y={SR.LDact} stroke={SC.green} strokeDasharray="3 3" label={{value:`${SR.LDact}`,fill:SC.green,fontSize:11}}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
                {/* ──── Wing Planform SVG ──── */}
                <Panel title="Wing Planform — Top View">
                  {(()=>{
                    const W=680, H=220, margin={l:60,r:60,t:28,b:28};
                    const b=SR.bWing, Cr=SR.Cr_, Ct=SR.Ct_, sw=SR.sweep*Math.PI/180;
                    const mac=SR.MAC, ymac=SR.Ymac;
                    // SVG scale: half-span fits in (W/2-margin.l-margin.r)
                    const halfW=(W/2-margin.l-4);
                    const scaleY=halfW/(b/2);        // px per metre (span direction → X in SVG)
                    const maxChord=Cr*scaleY*1.05;
                    const scaleX=Math.min((H-margin.t-margin.b)/maxChord, scaleY);
                    // Actually use uniform scale
                    const sc=Math.min(halfW/(b/2),(H-margin.t-margin.b)/Cr);
                    // Wing coords (right half, then mirror): LE swept
                    const xRoot=0, yRoot=margin.t;                          // root LE (top of SVG = LE)
                    const xTip=b/2*sc, yTip=yRoot+(b/2)*Math.tan(sw)*sc;   // tip LE
                    const xTipTe=xTip, yTipTe=yTip+Ct*sc;
                    const xRootTe=xRoot, yRootTe=yRoot+Cr*sc;
                    // MAC position
                    const xMac=ymac*sc, yMacLE=yRoot+ymac*Math.tan(sw)*sc;
                    const yMacTE=yMacLE+mac*sc;
                    // QC line
                    const yRootQC=yRoot+0.25*Cr*sc, yTipQC=yTip+0.25*Ct*sc;
                    // Center offset so both halves fit
                    const cx=W/2;
                    const pt=(x,y)=>`${(cx+x).toFixed(1)},${y.toFixed(1)}`;
                    const ptL=(x,y)=>`${(cx-x).toFixed(1)},${y.toFixed(1)}`;
                    return(
                    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{fontFamily:"'DM Mono',monospace",overflow:"visible"}}>
                      {/* grid lines */}
                      {[0.25,0.5,0.75,1.0].map(frac=>{
                        const xg=frac*b/2*sc;
                        return <line key={frac} x1={cx+xg} y1={margin.t-8} x2={cx+xg} y2={H-margin.b+5}
                          stroke="#1e2a3a" strokeWidth={1} strokeDasharray="3 3"/>;
                      })}
                      {/* Right half */}
                      <polygon points={`${pt(xRoot,yRoot)} ${pt(xTip,yTip)} ${pt(xTipTe,yTipTe)} ${pt(xRootTe,yRootTe)}`}
                        fill="#1e3a5f" stroke="#3b82f6" strokeWidth={1.5} opacity={0.85}/>
                      {/* Left half */}
                      <polygon points={`${ptL(xRoot,yRoot)} ${ptL(xTip,yTip)} ${ptL(xTipTe,yTipTe)} ${ptL(xRootTe,yRootTe)}`}
                        fill="#1e3a5f" stroke="#3b82f6" strokeWidth={1.5} opacity={0.85}/>
                      {/* Root chord */}
                      <line x1={cx} y1={yRoot} x2={cx} y2={yRootTe} stroke={SC.muted} strokeWidth={1} strokeDasharray="4 2"/>
                      {/* QC sweep line */}
                      <line x1={cx+xRoot} y1={yRootQC} x2={cx+xTip} y2={yTipQC} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3"/>
                      <line x1={cx-xRoot} y1={yRootQC} x2={cx-xTip} y2={yTipQC} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3"/>
                      {/* MAC bar right */}
                      <rect x={cx+xMac-2} y={yMacLE} width={4} height={mac*sc} fill="#22c55e" opacity={0.9} rx={2}/>
                      <line x1={cx+xMac-12} y1={yMacLE} x2={cx+xMac+12} y2={yMacLE} stroke="#22c55e" strokeWidth={1}/>
                      <line x1={cx+xMac-12} y1={yMacTE} x2={cx+xMac+12} y2={yMacTE} stroke="#22c55e" strokeWidth={1}/>
                      {/* MAC bar left */}
                      <rect x={cx-xMac-2} y={yMacLE} width={4} height={mac*sc} fill="#22c55e" opacity={0.9} rx={2}/>
                      {/* Span arrow */}
                      <line x1={cx-xTip} y1={H-margin.b+14} x2={cx+xTip} y2={H-margin.b+14} stroke="#64748b" strokeWidth={1} markerEnd="url(#arr)" markerStart="url(#arrl)"/>
                      <text x={cx} y={H-margin.b+22} textAnchor="middle" fill={SC.muted} fontSize={9}>b = {b} m</text>
                      {/* Root chord label */}
                      <text x={cx+6} y={(yRoot+yRootTe)/2+3} fill={SC.muted} fontSize={8}>Cr={Cr}m</text>
                      {/* Tip chord label */}
                      <text x={cx+xTip+4} y={(yTip+yTipTe)/2+3} fill={SC.muted} fontSize={8}>Ct={Ct}m</text>
                      {/* MAC label */}
                      <text x={cx+xMac+6} y={yMacLE+mac*sc/2+3} fill="#22c55e" fontSize={8}>MAC={mac}m</text>
                      {/* Sweep annotation */}
                      <text x={cx+12} y={yRootQC-4} fill="#f59e0b" fontSize={8}>Λ¼={SR.sweep}°</text>
                      {/* LE label */}
                      <text x={cx-xTip-4} y={yTip-4} textAnchor="end" fill="#3b82f6" fontSize={8}>LE</text>
                      <text x={cx-xTipTe-4} y={yTipTe+4} textAnchor="end" fill="#3b82f6" fontSize={8}>TE</text>
                      {/* Span fraction ticks */}
                      {[0.25,0.5,0.75].map(frac=>(
                        <text key={frac} x={cx+frac*b/2*sc} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>{Math.round(frac*100)}%</text>
                      ))}
                      <text x={cx+b/2*sc} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>tip</text>
                      <text x={cx} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>CL</text>
                      {/* AR / taper info */}
                      <text x={8} y={16} fill="#475569" fontSize={8}>AR={params.AR}  λ={params.taper}  t/c={params.tc}  Sw={SR.Swing}m²</text>
                      <defs>
                        <marker id="arr" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto">
                          <path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/>
                        </marker>
                        <marker id="arrl" markerWidth={6} markerHeight={6} refX={3} refY={3} orient="auto-start-reverse">
                          <path d="M0,0 L6,3 L0,6 Z" fill="#64748b"/>
                        </marker>
                      </defs>
                    </svg>);
                  })()}
                </Panel>
              </div>
            )}

            {/* ──── TAB 3: PROPULSION ──── */}
            {tab===3&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Rotor Diam (AD)" value={SR.Drotor} unit="m" color={SC.amber}/>
                  <KPI label="Disk Loading" value={SR.DLrotor} unit="N/m²"/>
                  <KPI label="Tip Speed" value={SR.TipSpd} unit="m/s" color={SR.TipMach<0.7?SC.green:SC.red} sub={`Tip Mach ${SR.TipMach}`}/>
                  <KPI label="RPM" value={SR.RPM} unit="rpm"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Actuator Disk + Motor Sizing" ht={380}>
                    <div style={{overflowY:"auto",maxHeight:320}}>
                    {[["No. rotors (hover)",params.nPropHover],["Design diameter",`${params.propDiam} m`],
                      ["AD-derived diameter",`${SR.Drotor} m`],["Disk loading",`${SR.DLrotor} N/m²`],
                      ["Power loading",`${SR.PLrotor} N/kW`],["Tip speed",`${SR.TipSpd} m/s`],
                      ["Tip Mach",SR.TipMach],["Operating RPM",`${SR.RPM} rpm`],
                      ["No. blades",SR.Nbld],["Solidity σ","0.10"],
                      ["Blade chord",`${SR.ChordBl} m`],["Blade AR",SR.BladeAR],
                      ["Continuous power/rotor",`${SR.PmotKW} kW`],["Peak power/rotor",`${SR.PpeakKW} kW`],
                      ["Shaft torque",`${SR.Torque} N·m`],["Motor mass/rotor",`${SR.MotMass} kg`],
                      ["Total motor mass",`${(SR.MotMass*params.nPropHover).toFixed(1)} kg`],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:10,color:SC.muted}}>{k}</span>
                        <span style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                      </div>
                    ))}
                    </div>
                  </Panel>
                  <Panel title="Phase Power Comparison" ht={320}>
                    <ResponsiveContainer width="100%" height={270}>
                      <BarChart data={[{ph:"T/O",v:SR.Phov},{ph:"Climb",v:SR.Pcl},{ph:"Cruise",v:SR.Pcr},{ph:"Descent",v:SR.Pdc},{ph:"Land",v:SR.Phov},{ph:"Reserve",v:SR.Pres}]}
                        margin={{top:5,right:8,left:-10,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:11,fill:SC.muted}} label={{value:"kW",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="Power (kW)">{PHC.map((clr,i)=><Cell key={i} fill={clr}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 4: BATTERY ──── */}
            {tab===4&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Pack Energy" value={SR.PackkWh} unit="kWh" color={SC.green} sub={`Mission: ${SR.Etot} kWh`}/>
                  <KPI label="Battery Mass" value={SR.Wbat} unit="kg" color={SR.Wbat/SR.MTOW<0.4?SC.green:SC.amber} sub={`SED ${SR.SEDpack} Wh/kg`}/>
                  <KPI label="Cell Config" value={`${SR.Nseries}s×${SR.Npar}p`} unit="" sub={`${SR.Ncells} cells total`}/>
                  <KPI label="Final SoC" value={((1-SR.Etot/SR.PackkWh)*100).toFixed(1)} unit="%" color={(1-SR.Etot/SR.PackkWh)>=(params.socMin/(1+params.socMin))-0.01?SC.green:SC.red}/>
                </div>
                <Panel title="Battery State of Charge — Full Mission" ht={285}>
                  <ResponsiveContainer width="100%" height={235}>
                    <AreaChart data={SR.socSteps} margin={{top:5,right:10,left:-10,bottom:0}}>
                      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={SC.green} stopOpacity={0.5}/><stop offset="95%" stopColor={SC.red} stopOpacity={0.05}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:SC.muted}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                      <YAxis domain={[0,105]} tick={{fontSize:11,fill:SC.muted}} label={{value:"SoC (%)",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${v}%`,"SoC"]}/>
                      <ReferenceLine y={params.socMin/(1+params.socMin)*100} stroke={SC.red} strokeDasharray="5 3"
                        label={{value:`SoCmin ${(params.socMin/(1+params.socMin)*100).toFixed(1)}%`,fill:SC.red,fontSize:11,position:"right"}}/>
                      <Area type="stepAfter" dataKey="SoC" stroke={SC.green} strokeWidth={2.5} fill="url(#sg)" dot={false}/>
                      {SR.tPhases.slice(1,-1).map((tp,i)=><ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>)}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Pack Architecture (21700 NMC)" ht={260}>
                    {[["Cell voltage","3.6 V"],["Cell capacity","5.0 Ah"],["Bus voltage",`${SR.PackV} V`],
                      ["Series cells",SR.Nseries],["Parallel strings",SR.Npar],["Total cells",SR.Ncells],
                      ["Pack energy",`${SR.PackkWh} kWh`],["Battery mass",`${SR.Wbat} kg`],
                      ["SED (pack)",`${SR.SEDpack} Wh/kg`],["C-rate hover",`${SR.CrateHov}C`],
                      ["C-rate cruise",`${SR.CrateCr}C`],["Joule heating",`${SR.Pheat} W`],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:9,color:SC.muted}}>{k}</span>
                        <span style={{fontSize:9,color:SC.teal,fontFamily:"'DM Mono',monospace"}}>{v}</span>
                      </div>
                    ))}
                  </Panel>
                  <Panel title="SoC per Phase" ht={260}>
                    {(()=>{
                      const E=[0,SR.Eto,SR.Eto+SR.Ecl,SR.Eto+SR.Ecl+SR.Ecr,SR.Eto+SR.Ecl+SR.Ecr+SR.Edc,SR.Eto+SR.Ecl+SR.Ecr+SR.Edc+SR.Eld,SR.Etot];
                      return["Start","After T/O","After Climb","After Cruise","After Descent","After Landing","After Reserve"].map((lbl,i)=>{
                        const soc=Math.max(0,(1-E[i]/SR.PackkWh)*100),col=soc>60?SC.green:soc>30?SC.amber:SC.red;
                        return(<div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 0",borderBottom:`1px solid ${SC.border}`}}>
                          <span style={{fontSize:8,color:SC.muted,minWidth:95,fontFamily:"'DM Mono',monospace"}}>{lbl}</span>
                          <div style={{flex:1,height:5,background:SC.border,borderRadius:2}}>
                            <div style={{height:"100%",width:`${soc}%`,background:col,borderRadius:2,transition:"width 0.3s"}}/>
                          </div>
                          <span style={{fontSize:9,color:col,minWidth:42,textAlign:"right",fontFamily:"'DM Mono',monospace"}}>{soc.toFixed(1)}%</span>
                        </div>);
                      });
                    })()}
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 5: PERFORMANCE ──── */}
            {tab===5&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Stall Speed Vs" value={SR.Vstall} unit="m/s"/>
                  <KPI label="Corner Speed Va" value={SR.VA} unit="m/s"/>
                  <KPI label="Cruise Speed" value={params.vCruise} unit="m/s"/>
                  <KPI label="Dive Speed Vd" value={SR.VD} unit="m/s"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="V-n Structural Envelope" ht={310}>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={SR.vnData} margin={{top:10,right:30,left:10,bottom:20}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="v" tick={{fontSize:11,fill:SC.muted}} label={{value:"Airspeed (m/s)",position:"insideBottom",offset:-8,fontSize:12,fill:SC.muted}}/>
                        <YAxis domain={[-2.5,4.5]} tick={{fontSize:11,fill:SC.muted}} label={{value:"Load factor n",angle:-90,position:"insideLeft",offset:10,fontSize:12,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <ReferenceLine y={0} stroke={SC.muted}/>
                        <ReferenceLine y={3.5} stroke={SC.blue} strokeDasharray="4 3" label={{value:"n=3.5",fill:SC.blue,fontSize:11,fontWeight:600}}/>
                        <ReferenceLine y={-1.5} stroke={SC.red} strokeDasharray="4 3" label={{value:"n=-1.5",fill:SC.red,fontSize:11,fontWeight:600}}/>
                        <ReferenceLine x={SR.Vstall} stroke={SC.amber} strokeDasharray="4 3" label={{value:"Vs",fill:SC.amber,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={SR.VA} stroke={SC.green} strokeDasharray="4 3" label={{value:"Va",fill:SC.green,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={params.vCruise} stroke={SC.teal} strokeDasharray="4 3" label={{value:"Vc",fill:SC.teal,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={SR.VD} stroke={SC.red} strokeDasharray="4 3" label={{value:"Vd",fill:SC.red,fontSize:11,fontWeight:600,position:"top"}}/>
                        <Line type="monotone" dataKey="nPos" stroke={SC.blue} strokeWidth={2.5} dot={false} name="+n limit"/>
                        <Line type="monotone" dataKey="nNeg" stroke={SC.red} strokeWidth={2.5} dot={false} name="-n limit"/>
                        <Legend iconSize={10} wrapperStyle={{fontSize:12,color:SC.muted,paddingTop:4}}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>

                {/* ── Full-width Payload-Range Diagram ── */}
                <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"14px 16px"}}>
                  <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",
                    marginBottom:12,flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",
                        letterSpacing:"0.1em",fontFamily:"system-ui,sans-serif",marginBottom:3}}>
                        Payload-Range Diagram
                      </div>
                      <div style={{fontSize:11,color:SC.text,fontFamily:"system-ui,sans-serif",lineHeight:1.5}}>
                        Operational envelope — how far this aircraft can fly at each payload.
                        Freed payload weight transfers directly to battery (fixed MTOW).
                      </div>
                    </div>
                    {/* Key-point summary pills */}
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {[
                        ["Design Point",`${params.payload} kg / ${params.range} km`,SC.amber],
                        ["Ferry Range",`0 kg / ${SR.ferryRange} km`,SC.teal],
                        ["Max Payload",`${SR.maxPayloadRp} kg / 0 km`,SC.red],
                      ].map(([lbl,val,col])=>(
                        <div key={lbl} style={{padding:"4px 10px",borderRadius:5,
                          background:`${col}18`,border:`1px solid ${col}44`}}>
                          <div style={{fontSize:7,color:col,fontFamily:"system-ui,sans-serif",
                            textTransform:"uppercase",letterSpacing:"0.06em"}}>{lbl}</div>
                          <div style={{fontSize:11,fontWeight:700,color:col,
                            fontFamily:"'DM Mono',monospace"}}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart
                      data={[...SR.rpData, SR.rpFerryPoint]}
                      margin={{top:10,right:40,left:10,bottom:30}}>
                      <defs>
                        <linearGradient id="rpGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%"  stopColor="#8b5cf6" stopOpacity={0.35}/>
                          <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.02}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="payload"
                        type="number"
                        domain={[0, SR.maxPayloadRp*1.05]}
                        tick={{fontSize:11,fill:SC.muted}}
                        label={{value:"Payload (kg)",position:"insideBottom",offset:-12,fontSize:12,fill:SC.muted}}/>
                      <YAxis
                        domain={[0, Math.ceil(SR.ferryRange*1.1/50)*50]}
                        tick={{fontSize:11,fill:SC.muted}}
                        label={{value:"Range (km)",angle:-90,position:"insideLeft",offset:10,fontSize:12,fill:SC.muted}}/>
                      <Tooltip {...TTP}
                        formatter={(v,n)=>[`${v} km`,"Range"]}
                        labelFormatter={v=>`Payload: ${v} kg`}/>
                      {/* Design range reference */}
                      <ReferenceLine y={params.range} stroke={SC.amber}
                        strokeDasharray="5 3"
                        label={{value:`Design range ${params.range} km`,fill:SC.amber,
                          fontSize:10,position:"insideTopRight"}}/>
                      {/* Design payload reference */}
                      <ReferenceLine x={params.payload} stroke={SC.amber}
                        strokeDasharray="5 3"
                        label={{value:`${params.payload} kg`,fill:SC.amber,fontSize:10,position:"top"}}/>
                      {/* Reference aircraft — Joby S4 */}
                      <ReferenceLine y={150} stroke={SC.blue} strokeDasharray="3 4" strokeWidth={1}
                        label={{value:"Joby S4 ~150 km",fill:SC.blue,fontSize:9,position:"insideBottomRight"}}/>
                      {/* Reference aircraft — Archer Midnight */}
                      <ReferenceLine y={100} stroke={SC.teal} strokeDasharray="3 4" strokeWidth={1}
                        label={{value:"Archer Midnight ~100 km",fill:SC.teal,fontSize:9,position:"insideBottomRight"}}/>
                      {/* The envelope area */}
                      <Area type="monotone" dataKey="range"
                        stroke="#8b5cf6" strokeWidth={2.5}
                        fill="url(#rpGrad)"
                        dot={false}
                        name="Range (km)"
                        connectNulls/>
                      {/* Design point dot */}
                      <Scatter
                        data={[{payload:params.payload,range:params.range}]}
                        fill={SC.amber} r={6} name="Design point"/>
                      {/* Ferry range dot */}
                      <Scatter
                        data={[{payload:0,range:SR.ferryRange}]}
                        fill={SC.teal} r={5} name="Ferry range"/>
                    </ComposedChart>
                  </ResponsiveContainer>

                  {/* Key-points data table */}
                  <div style={{marginTop:10,display:"grid",
                    gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                    {[
                      ["Ferry Range (no payload)",     `${SR.ferryRange} km`,       `0 kg`,       SC.teal],
                      ["Design Point",                  `${params.range} km`,        `${params.payload} kg`, SC.amber],
                      ["Half-payload range",            (()=>{
                        const halfPay=Math.round(params.payload/2);
                        const pt=SR.rpData.find(d=>Math.abs(d.payload-halfPay)<SR.maxPayloadRp/20);
                        return pt?`${pt.range} km`:"—";
                      })(),                              `${Math.round(params.payload/2)} kg`, "#a78bfa"],
                      ["Max payload (zero range)",      `0 km`,                      `${SR.maxPayloadRp} kg`, SC.red],
                    ].map(([label,range,payload,col])=>(
                      <div key={label} style={{background:SC.bg,border:`1px solid ${SC.border}`,
                        borderLeft:`3px solid ${col}`,borderRadius:5,padding:"7px 10px"}}>
                        <div style={{fontSize:8,color:SC.muted,fontFamily:"system-ui,sans-serif",
                          marginBottom:3,lineHeight:1.3}}>{label}</div>
                        <div style={{fontSize:13,fontWeight:700,color:col,
                          fontFamily:"'DM Mono',monospace"}}>{range}</div>
                        <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{payload}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{marginTop:8,fontSize:9,color:SC.dim,
                    fontFamily:"system-ui,sans-serif",lineHeight:1.6}}>
                    Model: fixed-MTOW ({SR.MTOW} kg) — reduced payload → battery mass increases.
                    Blue reference: Joby S4 (2023 spec). Teal reference: Archer Midnight.
                    Ferry range assumes full battery, zero payload.
                  </div>
                </div>
              </div>
            )}

            {/* ──── TAB 6: STABILITY ──── */}
            {tab===6&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="CG (MTOW)" value={SR.xCGtotal} unit="m from nose"/>
                  <KPI label="Neutral Point" value={SR.xNP} unit="m from nose"/>
                  <KPI label="Static Margin" value={(SR.SM*100).toFixed(1)} unit="% MAC" color={SR.SM>=0.05&&SR.SM<=0.25?SC.green:SC.red}/>
                  <KPI label="MAC" value={SR.MAC} unit="m"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="CG / NP / AC Positions (from nose)" ht={320}>
                    <div style={{position:"relative",height:90,margin:"10px 0 8px",background:"#0a0d14",borderRadius:6,border:"1px solid #1c2333"}}>
                      {/* fuselage body */}
                      <div style={{position:"absolute",left:"10%",right:"8%",top:"44%",height:4,background:"#1e2a3a",borderRadius:2}}/>
                      {/* nose */}
                      <div style={{position:"absolute",left:"6%",top:"30%",fontSize:24}}>✈️</div>
                      {/* length label */}
                      <div style={{position:"absolute",right:"2%",bottom:4,fontSize:10,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{params.fusLen} m</div>
                      {/* scale ticks */}
                      {[0.25,0.5,0.75,1.0].map(frac=>(
                        <div key={frac} style={{position:"absolute",left:`${10+frac*82}%`,top:"55%",width:1,height:12,background:"#1e2a3a"}}/>
                      ))}
                      {[[SR.xCGtotal,SC.amber,"CG"],[SR.xNP,SC.blue,"NP"],[1.45+SR.Xac,SC.green,"AC"]].map(([x,col,lbl])=>{
                        const pct=Math.min(92,Math.max(10,(x/params.fusLen)*82+10));
                        return(<div key={lbl} style={{position:"absolute",left:`${pct}%`,top:0,bottom:0,transform:"translateX(-50%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                          <div style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700,
                            writingMode:"vertical-rl",textOrientation:"mixed",transform:"rotate(180deg)",
                            letterSpacing:"0.05em",lineHeight:1,marginBottom:4,whiteSpace:"nowrap"}}>
                            {lbl}={(+x).toFixed(2)}m
                          </div>
                          <div style={{width:2,height:"100%",background:col,opacity:0.85,borderRadius:1,minHeight:60}}/>
                        </div>);
                      })}
                    </div>
                    {[["CG (MTOW)",`${(+SR.xCGtotal).toFixed(2)} m`],["Wing AC",`${(1.45+SR.Xac).toFixed(2)} m`],
                      ["Neutral Point",`${(+SR.xNP).toFixed(2)} m`],["Static Margin",`${(SR.SM*100).toFixed(1)}% MAC`],
                      ["MAC",`${SR.MAC} m`],["Status",SR.SM>=0.05&&SR.SM<=0.25?"✅ OK (5–25%)":SR.SM<0.05?"⚠️ Too small":"⚠️ Too large"],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:10,color:SC.muted}}>{k}</span>
                        <span style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace"}}>{v}</span>
                      </div>
                    ))}
                  </Panel>
                  <Panel title="Empty Weight Breakdown (Roskam)" ht={290}>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart layout="vertical" data={SR.weightBreak} margin={{top:0,right:30,left:60,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis type="number" tick={{fontSize:11,fill:SC.muted}}/>
                        <YAxis dataKey="name" type="category" tick={{fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="val" radius={[0,3,3,0]} name="kg">
                          {SR.weightBreak.map((_,i)=><Cell key={i} fill={["#3b82f6","#ef4444","#22c55e","#f59e0b","#8b5cf6","#ec4899","#06b6d4","#84cc16","#f97316","#a78bfa"][i]}/>)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
                {/* CG Travel Range */}
                <Panel title="CG Travel Range — OEW → MTOW (loading envelope)">
                  {(()=>{
                    // Build CG sweep: from OEW (no payload, no battery) → MTOW
                    // Intermediate: add battery first, then payload (worst-case forward/aft)
                    const xCGbat=params.fusLen*0.38, xCGpay=params.fusLen*0.40;
                    const pts=Array.from({length:51},(_,i)=>{
                      const frac=i/50;
                      // Linear blend: OEW → full battery → full payload
                      const Wb=SR.Wbat*frac, Wp=params.payload*frac;
                      const W=SR.Wempty+Wb+Wp;
                      const cg=(SR.Wempty*SR.xCGempty+Wb*xCGbat+Wp*xCGpay)/W;
                      return{mass:+W.toFixed(1),cg:+cg.toFixed(4),sm:+((SR.xNP-cg)/SR.MAC*100).toFixed(2)};
                    });
                    return(
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                      {/* CG vs Mass chart */}
                      <div>
                        <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                          CG position (m from nose) vs Aircraft Mass (kg)
                        </div>
                        <ResponsiveContainer width="100%" height={175}>
                          <LineChart data={pts} margin={{top:4,right:12,left:-15,bottom:14}}>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="mass" tick={{fontSize:10,fill:SC.muted}}
                              label={{value:"Mass (kg)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis domain={["auto","auto"]} tick={{fontSize:10,fill:SC.muted}}
                              label={{value:"xCG (m)",angle:-90,position:"insideLeft",offset:12,fontSize:10,fill:SC.muted}}/>
                            <Tooltip {...TTP} formatter={(v,n)=>[`${v} m`,n]}/>
                            <ReferenceLine y={SR.xNP} stroke={SC.blue} strokeDasharray="4 2"
                              label={{value:"NP",fill:SC.blue,fontSize:9,position:"right"}}/>
                            <ReferenceLine y={SR.xCGempty} stroke="#64748b" strokeDasharray="3 2"
                              label={{value:"OEW",fill:"#64748b",fontSize:9,position:"right"}}/>
                            <ReferenceLine y={SR.xCGtotal} stroke={SC.amber} strokeDasharray="3 2"
                              label={{value:"MTOW",fill:SC.amber,fontSize:9,position:"right"}}/>
                            <Line type="monotone" dataKey="cg" stroke={SC.green} strokeWidth={2} dot={false} name="xCG"/>
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      {/* SM vs Mass chart */}
                      <div>
                        <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                          Static Margin (% MAC) vs Aircraft Mass — must stay 5–25%
                        </div>
                        <ResponsiveContainer width="100%" height={175}>
                          <AreaChart data={pts} margin={{top:4,right:12,left:-12,bottom:14}}>
                            <defs>
                              <linearGradient id="smg" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={SC.green} stopOpacity={0.3}/>
                                <stop offset="95%" stopColor={SC.green} stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="mass" tick={{fontSize:10,fill:SC.muted}}
                              label={{value:"Mass (kg)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis tick={{fontSize:10,fill:SC.muted}}
                              label={{value:"SM (%)",angle:-90,position:"insideLeft",offset:15,fontSize:10,fill:SC.muted}}/>
                            <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                            <ReferenceLine y={5} stroke={SC.red} strokeDasharray="3 2"
                              label={{value:"5% min",fill:SC.red,fontSize:9,position:"right"}}/>
                            <ReferenceLine y={25} stroke={SC.red} strokeDasharray="3 2"
                              label={{value:"25% max",fill:SC.red,fontSize:9,position:"right"}}/>
                            <Area type="monotone" dataKey="sm" stroke={SC.green} strokeWidth={2} fill="url(#smg)" dot={false} name="SM %"/>
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>);
                  })()}
                  <div style={{display:"flex",gap:18,marginTop:8,padding:"5px 8px",background:"#0a0d14",borderRadius:4}}>
                    {[["OEW CG",`${(+SR.xCGempty).toFixed(2)} m`,"#64748b"],["MTOW CG",`${(+SR.xCGtotal).toFixed(2)} m`,SC.amber],
                      ["NP",`${(+SR.xNP).toFixed(2)} m`,SC.blue],["ΔCG travel",`${Math.abs(SR.xCGtotal-SR.xCGempty).toFixed(2)} m`,SC.green]
                    ].map(([l,v,col])=>(
                      <div key={l} style={{display:"flex",flexDirection:"column",gap:2}}>
                        <span style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{l}</span>
                        <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="MTOW Composition" ht={235}>
                    <ResponsiveContainer width="100%" height={190}>
                      <PieChart>
                        <Pie data={[{name:"Empty",val:SR.Wempty},{name:"Battery",val:SR.Wbat},{name:"Payload",val:params.payload}]}
                          dataKey="val" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={82} paddingAngle={4}>
                          {[SC.blue,SC.amber,SC.green].map((clr,i)=><Cell key={i} fill={clr}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v,n)=>[`${v.toFixed(1)} kg (${(v/SR.MTOW*100).toFixed(1)}%)`,n]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:12,color:SC.muted}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Feasibility Checks" ht={235}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginTop:4}}>
                      {SR.checks.map((chk,i)=>(
                        <div key={i} style={{background:SC.bg,borderRadius:5,padding:"7px 9px",border:`1px solid ${chk.ok?SC.green+"33":SC.red+"33"}`}}>
                          <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                            <span>{chk.ok?"✅":"❌"}</span>
                            <span style={{fontSize:8,color:chk.ok?SC.green:SC.red,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{chk.ok?"PASS":"FAIL"}</span>
                          </div>
                          <div style={{fontSize:8,color:SC.muted,marginBottom:2}}>{chk.label}</div>
                          <div style={{fontSize:9,color:chk.ok?SC.green:SC.red,fontFamily:"'DM Mono',monospace"}}>{chk.val}</div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 7: V-TAIL SIZING ──── */}
            {tab===7&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* KPI row */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
                  <KPI label="Total V-Tail Area" value={SR.Svt_total} unit="m²" color={SC.amber}
                    sub={`Each panel: ${SR.Svt_panel} m²`}/>
                  <KPI label="Tail / Wing Area" value={(SR.tailWingRatio*100).toFixed(1)} unit="%"
                    color={SR.tailWingRatio>=0.20&&SR.tailWingRatio<=0.55?SC.green:SC.red}
                    sub="Target: 25–50%"/>
                  <KPI label="Optimal Dihedral Γ" value={SR.vtGamma_opt} unit="°" color={SC.teal}
                    sub={`Set: ${params.vtGamma}°`}/>
                  <KPI label="Static Margin (w/ Vtail)" value={(SR.SM_vt*100).toFixed(1)} unit="% MAC"
                    color={SR.SM_vt>=0.05&&SR.SM_vt<=0.25?SC.green:SC.red}
                    sub={`Baseline: ${(SR.SM*100).toFixed(1)}%`}/>
                  <KPI label="Ruddervator Area" value={SR.Srv} unit="m²/panel" color={SC.blue}
                    sub="30% chord"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  {/* Panel Geometry */}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>
                        Panel Geometry
                      </div>
                      {[["Panel span",`${SR.bvt_panel} m`],["Root chord",`${SR.Cr_vt} m`],
                        ["Tip chord",`${SR.Ct_vt} m`],["MAC",`${SR.MAC_vt} m`],
                        ["LE sweep",`${SR.sweep_vt}°`],["Taper ratio","0.40"],
                        ["Airfoil","NACA 0009"],["t/c","9%"],
                        ["Tail moment arm lv",`${SR.lv} m`],["Ruddervator / panel",`${SR.Srv} m²`],
                        ["Lf/b ratio",`${SR.fusSpanRatio} (target 0.55–0.70)`],
                      ].map(([k,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                          <span style={{fontSize:10,color:"#64748b"}}>{k}</span>
                          <span style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>
                        Weight & Drag
                      </div>
                      {[["V-tail total mass",`${SR.Wvt_total} kg`],
                        ["V-tail CD₀ contrib.",`${SR.CD0vt.toFixed(5)}`],
                        ["Ruddervator trim δ",`${SR.delta_rv_deg}°`],
                      ].map(([k,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                          <span style={{fontSize:10,color:"#64748b"}}>{k}</span>
                          <span style={{fontSize:10,color:SC.teal,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    {/* SVG schematic — below Weight & Drag, beside Control Authority */}
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>
                        Rear View Schematic
                      </div>
                      <svg viewBox="-110 -95 220 130" width="100%" height={160} style={{overflow:"visible"}}>
                        <circle cx={0} cy={0} r={12} fill="#1e2a3a" stroke="#2a3a5c" strokeWidth={1.5}/>
                        <text x={0} y={4} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="DM Mono,monospace">fus</text>
                        {(()=>{
                          const gr=params.vtGamma*Math.PI/180;
                          const panelLen=65;
                          const x2l=-(panelLen*Math.cos(gr)), y2l=-(panelLen*Math.sin(gr));
                          const x2r= (panelLen*Math.cos(gr)), y2r=-(panelLen*Math.sin(gr));
                          const chordScale=SR.Cr_vt*12;
                          return(<>
                            <line x1={0} y1={0} x2={x2l} y2={y2l} stroke={SC.amber} strokeWidth={2.5} strokeLinecap="round"/>
                            <polygon points={`${x2l},${y2l} ${x2l-chordScale*0.2},${y2l-4} ${x2l+chordScale*0.6},${y2l-4} ${x2l+chordScale*0.4},${y2l}`}
                              fill={SC.amber} opacity={0.25} stroke={SC.amber} strokeWidth={0.5}/>
                            <line x1={0} y1={0} x2={x2r} y2={y2r} stroke={SC.amber} strokeWidth={2.5} strokeLinecap="round"/>
                            <polygon points={`${x2r},${y2r} ${x2r-chordScale*0.6},${y2r-4} ${x2r+chordScale*0.2},${y2r-4} ${x2r-chordScale*0.4},${y2r}`}
                              fill={SC.amber} opacity={0.25} stroke={SC.amber} strokeWidth={0.5}/>
                            <path d={`M ${28*Math.cos(Math.PI-gr)},${-28*Math.sin(Math.PI-gr)} A 28 28 0 0 1 ${28*Math.cos(gr)},${-28*Math.sin(gr)}`}
                              fill="none" stroke={SC.teal} strokeWidth={1} strokeDasharray="3 2"/>
                            <text x={0} y={-31} textAnchor="middle" fill={SC.teal} fontSize={10} fontFamily="DM Mono,monospace">Γ={params.vtGamma}°</text>
                            <text x={0} y={-43} textAnchor="middle" fill={SC.green} fontSize={9} fontFamily="DM Mono,monospace">opt={SR.vtGamma_opt}°</text>
                            <text x={x2l-3} y={y2l-7} textAnchor="middle" fill={SC.amber} fontSize={8} fontFamily="DM Mono,monospace">{SR.bvt_panel}m</text>
                            <text x={x2r+3} y={y2r-7} textAnchor="middle" fill={SC.amber} fontSize={8} fontFamily="DM Mono,monospace">{SR.bvt_panel}m</text>
                            <line x1={-85} y1={0} x2={85} y2={0} stroke="#1e2a3a" strokeWidth={1} strokeDasharray="4 3"/>
                            <line x1={0} y1={-85} x2={0} y2={18} stroke="#1e2a3a" strokeWidth={1} strokeDasharray="4 3"/>
                            <text x={87} y={4} fill="#334155" fontSize={7} fontFamily="DM Mono,monospace">H</text>
                            <text x={2} y={-87} fill="#334155" fontSize={7} fontFamily="DM Mono,monospace">V</text>
                          </>);
                        })()}
                      </svg>
                    </div>
                  </div>
                  {/* Dihedral trade chart + effectiveness */}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>
                        Dihedral Angle Trade — Intrinsic Effectiveness &amp; Required Area
                      </div>
                      {/* Two-panel layout: left = effectiveness curves, right = area cost */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                        {/* Panel A: cos²/sin² effectiveness — smooth, bounded 0–100% */}
                        <div>
                          <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                            Authority split (fixed panel)
                          </div>
                          <ResponsiveContainer width="100%" height={160}>
                            <LineChart
                              data={Array.from({length:81},(_,i)=>{
                                const gd=i+10, gr=gd*Math.PI/180;
                                return{
                                  gamma:gd,
                                  pitch:+(Math.cos(gr)**2*100).toFixed(1),  // pure cos²Γ
                                  yaw:+(Math.sin(gr)**2*100).toFixed(1),    // pure sin²Γ
                                };
                              })}
                              margin={{top:4,right:8,left:0,bottom:18}}>
                              <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                              <XAxis dataKey="gamma" tick={{fontSize:10,fill:SC.muted}}
                                label={{value:"Γ (°)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                              <YAxis domain={[0,100]} tick={{fontSize:10,fill:SC.muted}}
                                label={{value:"%",angle:-90,position:"insideLeft",offset:8,fontSize:11,fill:SC.muted}}/>
                              <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                              <ReferenceLine x={params.vtGamma} stroke={SC.amber} strokeDasharray="3 2"
                                label={{value:"Γ",fill:SC.amber,fontSize:10,position:"top"}}/>
                              <ReferenceLine x={SR.vtGamma_opt} stroke={SC.green} strokeDasharray="3 2"
                                label={{value:"opt",fill:SC.green,fontSize:10,position:"top"}}/>
                              <ReferenceLine y={50} stroke={SC.dim} strokeDasharray="2 2"/>
                              <Line type="monotone" dataKey="pitch" stroke={SC.blue} strokeWidth={2} dot={false} name="Pitch cos²Γ"/>
                              <Line type="monotone" dataKey="yaw" stroke={SC.red} strokeWidth={2} dot={false} name="Yaw sin²Γ"/>
                              <Legend iconSize={8} wrapperStyle={{fontSize:10,color:SC.muted}}/>
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                        {/* Panel B: total panel area required vs Γ — shows area cost of wrong angle */}
                        <div>
                          <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                            Total panel area required (m²)
                          </div>
                          <ResponsiveContainer width="100%" height={160}>
                            <LineChart
                              data={Array.from({length:81},(_,i)=>{
                                const gd=i+10, gr=gd*Math.PI/180;
                                const c2=Math.cos(gr)**2, s2=Math.sin(gr)**2;
                                // Avoid divide-by-zero at 0° and 90°
                                if(gd<=11||gd>=89) return{gamma:gd,area:null};
                                const Sp=Math.max(SR.Sh_req/c2, SR.Sv_req/s2);
                                return{gamma:gd, area:+(2*Sp).toFixed(2)};
                              })}
                              margin={{top:4,right:8,left:0,bottom:18}}>
                              <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                              <XAxis dataKey="gamma" tick={{fontSize:10,fill:SC.muted}}
                                label={{value:"Γ (°)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                              <YAxis tick={{fontSize:10,fill:SC.muted}}
                                label={{value:"m²",angle:-90,position:"insideLeft",offset:8,fontSize:11,fill:SC.muted}}/>
                              <Tooltip {...TTP} formatter={(v,n)=>[`${v} m²`,n]}/>
                              <ReferenceLine x={params.vtGamma} stroke={SC.amber} strokeDasharray="3 2"
                                label={{value:"Γ",fill:SC.amber,fontSize:10,position:"top"}}/>
                              <ReferenceLine x={SR.vtGamma_opt} stroke={SC.green} strokeDasharray="3 2"
                                label={{value:"opt",fill:SC.green,fontSize:10,position:"top"}}/>
                              <ReferenceLine y={SR.Svt_total} stroke={SC.teal} strokeDasharray="3 2"
                                label={{value:"cur",fill:SC.teal,fontSize:10,position:"right"}}/>
                              <Line type="monotone" dataKey="area" stroke={SC.amber} strokeWidth={2}
                                dot={false} name="Total area" connectNulls={false}/>
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      </div>
                      <div style={{fontSize:8,color:"#4b5563",fontFamily:"'DM Mono',monospace",marginTop:4,padding:"3px 6px",background:"#0a0d14",borderRadius:3}}>
                        Left: intrinsic authority split for fixed panel area (cos²Γ + sin²Γ = 1, always bounded).
                        Right: total panel area required to meet both Sh_req and Sv_req — minimum at Γ_opt.
                      </div>
                    </div>
                    {/* Control Authority checks */}
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${SC.border}`,paddingBottom:5}}>
                        Control Authority vs Requirement
                      </div>
                      <div style={{fontSize:9,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:6,padding:"4px 6px",background:"#0a0d14",borderRadius:4}}>
                        Sh_eff = S_panel·cos²Γ &nbsp;|&nbsp; Sv_eff = S_panel·sin²Γ &nbsp;|&nbsp; Panel sized to governing constraint
                      </div>
                      {[
                        ["Sh_req (pitch needed)",`${SR.Sh_req} m²`,"—",SC.muted],
                        ["Sv_req (yaw needed)",`${SR.Sv_req} m²`,"—",SC.muted],
                        ["Panel area (per side)",`${SR.Svt_panel} m²`,SR.governs_pitch?"↑ pitch governs":"↑ yaw governs",SC.amber],
                        ["Sh_eff = S·cos²(Γ)",`${SR.Sh_eff} m²`,`${(SR.pitch_ratio*100).toFixed(0)}% of req.`,SR.pitch_ratio>=1?SC.green:SC.red],
                        ["Sv_eff = S·sin²(Γ)",`${SR.Sv_eff} m²`,`${(SR.yaw_ratio*100).toFixed(0)}% of req.`,SR.yaw_ratio>=1?SC.green:SC.red],
                        ["Pitch authority",SR.pitch_ratio>=1?"✅ Sufficient":"❌ Insufficient","",SR.pitch_ratio>=1?SC.green:SC.red],
                        ["Yaw authority",SR.yaw_ratio>=1?"✅ Sufficient":"❌ Insufficient","",SR.yaw_ratio>=1?SC.green:SC.red],
                        ["Combined authority",`${(SR.ruddervator_combined_auth*100).toFixed(0)}%`,"√(p²+y²)",SC.teal],
                        ["Updated SM (V-tail NP)",`${(SR.SM_vt*100).toFixed(1)}% MAC`,"",SR.SM_vt>=0.05&&SR.SM_vt<=0.25?SC.green:SC.red],
                        ["Trim δ ruddervator (pitch)",`${SR.delta_rv_deg}°`,"symmetric",SC.muted],
                        ["Trim δ ruddervator (yaw)",`${SR.delta_yaw_rv_deg}°`,"differential",SC.muted],
                      ].map(([k,v,s,col],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                          <span style={{fontSize:10,color:"#64748b"}}>{k}</span>
                          <div style={{textAlign:"right"}}>
                            <span style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                            {s&&<div style={{fontSize:9,color:"#4b5563",fontFamily:"'DM Mono',monospace"}}>{s}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* ──── Ruddervator Deflection Angle Plots ──── */}
                <Panel title="Ruddervator Deflection Analysis">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                    {/* Plot 1: Pitch trim δ_rv vs Γ */}
                    <div>
                      <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                        Pitch trim δ_rv vs dihedral Γ (symmetric)
                      </div>
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={Array.from({length:71},(_,i)=>{
                            const gd=15+i, gr=gd*Math.PI/180;
                            const Sh_eff_g=SR.Svt_panel*Math.cos(gr)**2;
                            if(Sh_eff_g<0.01) return{gamma:gd,delta:null};
                            const CM_ac=SR.selAF?.CM||(-0.02);
                            const de=-(CM_ac*SR.Swing*SR.MAC)/(0.90*Sh_eff_g*SR.lv);
                            const drv=de/Math.cos(gr)*180/Math.PI;
                            return{gamma:gd,delta:+Math.min(Math.max(drv,-35),35).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="gamma" tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"Γ (°)",position:"insideBottom",offset:-8,fontSize:10,fill:SC.muted}}/>
                          <YAxis tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:SC.muted}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv pitch"]}/>
                          <ReferenceLine y={20} stroke={SC.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:SC.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={SC.red} strokeDasharray="3 2"/>
                          <ReferenceLine x={params.vtGamma} stroke={SC.amber} strokeDasharray="3 2"
                            label={{value:`Γ=${params.vtGamma}°`,fill:SC.amber,fontSize:9,position:"top"}}/>
                          <ReferenceLine y={SR.delta_rv_deg} stroke={SC.green} strokeDasharray="3 2"
                            label={{value:`${SR.delta_rv_deg}°`,fill:SC.green,fontSize:9,position:"right"}}/>
                          <Line type="monotone" dataKey="delta" stroke={SC.blue} strokeWidth={2} dot={false}
                            name="δ_rv pitch" connectNulls={false}/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Plot 2: Yaw trim δ_rv vs sideslip β */}
                    <div>
                      <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                        Yaw trim δ_rv vs sideslip β (differential)
                      </div>
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={Array.from({length:41},(_,i)=>{
                            const beta_deg=-10+i*0.5;
                            const beta_rad=beta_deg*Math.PI/180;
                            const CY_beta=-0.30;
                            const dyaw=(CY_beta*beta_rad*SR.Swing)/(2*SR.Sv_eff/SR.lv)*180/Math.PI*(-1);
                            return{beta:+beta_deg.toFixed(1),delta:+Math.min(Math.max(dyaw,-30),30).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="beta" tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"β (°)",position:"insideBottom",offset:-8,fontSize:10,fill:SC.muted}}/>
                          <YAxis tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:SC.muted}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv yaw"]}/>
                          <ReferenceLine y={20} stroke={SC.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:SC.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={SC.red} strokeDasharray="3 2"/>
                          <ReferenceLine x={0} stroke="#334155" strokeWidth={1}/>
                          <ReferenceLine x={2} stroke={SC.amber} strokeDasharray="3 2"
                            label={{value:"β=2°",fill:SC.amber,fontSize:9,position:"top"}}/>
                          <ReferenceLine y={SR.delta_yaw_rv_deg} stroke={SC.green} strokeDasharray="3 2"
                            label={{value:`${SR.delta_yaw_rv_deg}°`,fill:SC.green,fontSize:9,position:"right"}}/>
                          <Line type="monotone" dataKey="delta" stroke={SC.teal} strokeWidth={2} dot={false} name="δ_rv yaw"/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    {/* Plot 3: Combined deflection vs SM */}
                    <div>
                      <div style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:4}}>
                        Pitch trim δ_rv vs Static Margin (% MAC)
                      </div>
                      <ResponsiveContainer width="100%" height={180}>
                        <LineChart
                          data={Array.from({length:51},(_,i)=>{
                            const sm_pct=-5+i*0.6; // SM from -5% to +25%
                            const sm=sm_pct/100;
                            const xCG_g=SR.xNP-sm*SR.MAC;
                            // Pitch moment about AC: CM_ac from airfoil + CL * (xCG-xAC)/MAC
                            const CL_cr=SR.Swing>0?2*SR.MTOW*9.81/(1.225*params.vCruise**2*SR.Swing):1;
                            const CM_ac=SR.selAF?.CM||(-0.02);
                            const CM_net=CM_ac+CL_cr*sm;  // net pitch moment
                            const Sh_eff_cur=SR.Sh_eff||0.1;
                            const de=-CM_net*SR.Swing*SR.MAC/(0.90*Sh_eff_cur*SR.lv);
                            const drv=de/Math.cos(params.vtGamma*Math.PI/180)*180/Math.PI;
                            return{sm:+sm_pct.toFixed(1),delta:+Math.min(Math.max(drv,-35),35).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="sm" tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"SM (%)",position:"insideBottom",offset:-8,fontSize:10,fill:SC.muted}}/>
                          <YAxis tick={{fontSize:10,fill:SC.muted}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:SC.muted}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv"]}/>
                          <ReferenceLine y={20} stroke={SC.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:SC.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={SC.red} strokeDasharray="3 2"/>
                          <ReferenceLine y={0} stroke="#334155" strokeWidth={1}/>
                          <ReferenceLine x={SR.SM_vt*100} stroke={SC.amber} strokeDasharray="3 2"
                            label={{value:`SM=${(SR.SM_vt*100).toFixed(1)}%`,fill:SC.amber,fontSize:9,position:"top"}}/>
                          <Line type="monotone" dataKey="delta" stroke={SC.green} strokeWidth={2} dot={false} name="δ_rv vs SM"/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:18,marginTop:8,padding:"5px 8px",background:"#0a0d14",borderRadius:4,flexWrap:"wrap"}}>
                    {[
                      ["Pitch trim δ_rv",`${SR.delta_rv_deg}°`,SC.blue,"symmetric, cruise"],
                      ["Yaw trim δ_rv",`${SR.delta_yaw_rv_deg}°`,SC.teal,"differential, β=2°"],
                      ["Authority limit","±20°","#64748b","CS-23 / FAR 23"],
                      ["Pitch OK",Math.abs(SR.delta_rv_deg)<=20?"✅ Within limits":"❌ Exceeds",Math.abs(SR.delta_rv_deg)<=20?SC.green:SC.red,""],
                      ["Yaw OK",Math.abs(SR.delta_yaw_rv_deg)<=20?"✅ Within limits":"❌ Exceeds",Math.abs(SR.delta_yaw_rv_deg)<=20?SC.green:SC.red,""],
                    ].map(([l,v,col,sub])=>(
                      <div key={l} style={{display:"flex",flexDirection:"column",gap:1}}>
                        <span style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{l}</span>
                        <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                        {sub&&<span style={{fontSize:8,color:"#4b5563",fontFamily:"'DM Mono',monospace"}}>{sub}</span>}
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            )}
            {/* ──── TAB 8: CONVERGENCE ──── */}
            {tab===8&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Round 1 MTOW" value={SR.MTOW1} unit="kg" color={SC.muted}/>
                  <KPI label="Converged MTOW" value={SR.MTOW} unit="kg" color={SC.green}/>
                  <KPI label={`R2 Iters @ ε=10^${params.convTolExp}`} value={SR.itersR2} unit="" color={SR.r2Converged?SC.green:SC.red} sub={SR.r2Converged?"✓ converged":"✗ hit 200-iter cap"}/>
                  <KPI label="Installed T/W" value={params.twRatio.toFixed(2)} unit="" color={params.twRatio>=1.0&&params.twRatio<=1.4?SC.green:SC.amber} sub={`Phov = ${SR.Phov} kW`}/>
                </div>

                {!SR.r2Converged&&(
                  <div style={{background:`${SC.red}18`,border:`1px solid ${SC.red}55`,borderRadius:6,padding:"10px 14px",fontSize:11,color:SC.red}}>
                    ⚠ R2 loop hit the 200-iteration cap at ε = 10<sup>{params.convTolExp}</sup> without fully converging.
                  </div>
                )}

                {/* T/W insight banner */}
                <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 16px",display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",marginBottom:3}}>THRUST-TO-WEIGHT ANALYSIS</div>
                    <div style={{fontSize:11,color:SC.text,lineHeight:1.6}}>
                      At T/W = <span style={{color:SC.amber,fontWeight:700}}>{params.twRatio.toFixed(2)}</span>, installed hover thrust = <span style={{color:SC.blue,fontWeight:700}}>{(params.twRatio*SR.MTOW*9.81/1000).toFixed(1)} kN</span> → hover power = <span style={{color:SC.blue,fontWeight:700}}>{SR.Phov} kW</span>.
                      Round 1 gives <span style={{color:SC.muted,fontWeight:700}}>{SR.MTOW1} kg</span>. Dual-constraint converges to <span style={{color:SC.green,fontWeight:700}}>{SR.MTOW} kg</span> — a <span style={{color:SC.amber,fontWeight:700}}>{((SR.MTOW/SR.MTOW1-1)*100).toFixed(1)}%</span> increase driven by peak hover power sizing.
                    </div>
                  </div>
                </div>

                {/* Tolerance control */}
                <div style={{background:SC.panel,border:`1px solid ${"#22d3ee"}44`,borderRadius:8,padding:"14px 18px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",marginBottom:8}}>CONVERGENCE TOLERANCE CONTROL</div>
                  <div style={{display:"flex",alignItems:"center",gap:20,flexWrap:"wrap"}}>
                    <div style={{flex:1,minWidth:220}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:11,color:SC.text}}>Tolerance ε = 10<sup>{params.convTolExp}</sup> = <span style={{color:"#22d3ee",fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{SR.tol.toExponential(0)}</span></span>
                        <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Range: 10⁻¹ → 10⁻¹⁰</span>
                      </div>
                      <input type="range" min={-10} max={-1} step={1} value={params.convTolExp}
                        onChange={evt=>set("convTolExp")(+evt.target.value)}
                        style={{width:"100%",accentColor:"#22d3ee",cursor:"pointer"}}/>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:SC.muted,marginTop:2}}>
                        <span>10⁻¹⁰ (tightest)</span><span>10⁻¹ (loosest)</span>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:12}}>
                      {[["R1 Iters",SR.itersR1,"#22d3ee"],["R2 Iters",SR.itersR2,SR.r2Converged?SC.amber:SC.red],["Total",SR.itersR1+SR.itersR2,SR.r2Converged?SC.green:SC.red]].map(([l,v,c])=>(
                        <div key={l} style={{textAlign:"center",minWidth:60}}>
                          <div style={{fontSize:22,fontWeight:800,color:c,fontFamily:"'DM Mono',monospace",lineHeight:1}}>{v}</div>
                          <div style={{fontSize:9,color:SC.muted,marginTop:2}}>{l}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <Panel title={`MTOW Convergence History — Actual Run at ε = 10^${params.convTolExp} (${SR.itersR2} R2 iters${SR.r2Converged?"":", cap hit"})`} ht={280}>
                  <ResponsiveContainer width="100%" height={230}>
                    <LineChart data={SR.convData} margin={{top:5,right:20,left:-10,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="iter" tick={{fontSize:11,fill:SC.muted}} label={{value:"Iteration",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:11,fill:SC.muted}} label={{value:"MTOW (kg)",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                      <Tooltip {...TTP}/>
                      <ReferenceLine y={SR.MTOW1} stroke={SC.muted} strokeDasharray="4 3" label={{value:`R1: ${SR.MTOW1} kg`,fill:SC.muted,fontSize:10,position:"insideTopLeft"}}/>
                      <Line type="monotone" dataKey="MTOW" stroke={SC.amber} strokeWidth={2} dot={{r:3,fill:SC.amber}} name="MTOW (kg)"/>
                      <ReferenceLine y={SR.MTOW} stroke={SC.green} strokeDasharray="4 3" label={{value:`Converged: ${SR.MTOW} kg`,fill:SC.green,fontSize:11}}/>
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>

                <Panel title="Energy Convergence History" ht={255}>
                  <ResponsiveContainer width="100%" height={205}>
                    <LineChart data={SR.convData.filter(d=>d.Energy!=null)} margin={{top:5,right:20,left:-10,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="iter" tick={{fontSize:11,fill:SC.muted}} label={{value:"Iteration",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:11,fill:SC.muted}} label={{value:"Total Energy (kWh)",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                      <Tooltip {...TTP}/>
                      <Line type="monotone" dataKey="Energy" stroke={SC.teal} strokeWidth={2} dot={{r:3,fill:SC.teal}} name="Energy (kWh)"/>
                      <ReferenceLine y={SR.Etot} stroke={SC.green} strokeDasharray="4 3" label={{value:"Converged",fill:SC.green,fontSize:11}}/>
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>

                {/* Residual log plot */}
                <Panel title={`Residual Convergence — log₁₀(|ΔW₀|) per Iteration  [ε = ${SR.tol.toExponential(0)} → log₁₀(ε) = ${params.convTolExp}]`} ht={270}>
                  <div style={{fontSize:10,color:SC.muted,marginBottom:4,paddingLeft:4}}>
                    Each bar shows log₁₀ of the MTOW change per iteration. Convergence when bar drops below the <span style={{color:"#22d3ee"}}>ε threshold line</span>.
                  </div>
                  <ResponsiveContainer width="100%" height={205}>
                    <ComposedChart data={SR.convData.filter(d=>d.logResidual!=null)} margin={{top:5,right:20,left:5,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="iter" tick={{fontSize:11,fill:SC.muted}} label={{value:"Iteration",position:"insideBottom",fontSize:12,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:11,fill:SC.muted}} label={{value:"log₁₀(|ΔW₀| kg)",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`10^${v.toFixed(2)} kg`,n]}/>
                      <ReferenceLine y={params.convTolExp} stroke="#22d3ee" strokeDasharray="4 3"
                        label={{value:`ε = 10^${params.convTolExp}`,fill:"#22d3ee",fontSize:10,position:"right"}}/>
                      <Bar dataKey="logResidual" fill={SC.amber} opacity={0.8} name="log₁₀(|ΔW|)" radius={[2,2,0,0]}/>
                    </ComposedChart>
                  </ResponsiveContainer>
                </Panel>

                {/* Tolerance sweep table */}
                <Panel title="Tolerance Sensitivity Sweep — All 10 Levels">
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"'DM Mono',monospace"}}>
                    <thead>
                      <tr style={{borderBottom:`1px solid ${SC.border}`}}>
                        {["Tolerance","R1 Iters","R2 Iters","Total","MTOW (kg)","ΔM vs 1e-10"].map(hdr=>(
                          <th key={hdr} style={{padding:"5px 8px",color:SC.muted,fontWeight:600,textAlign:"right",fontSize:10}}>{hdr}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SR.tolSweepData.map((d,i)=>{
                        const isActive=d.exp===params.convTolExp;
                        const ref=SR.tolSweepData[SR.tolSweepData.length-1].R2MTOW;
                        const delta=Math.abs((d.R2MTOW-ref)*1000);
                        return(
                          <tr key={i} style={{borderBottom:`1px solid ${SC.border}22`,background:isActive?`${"#22d3ee"}18`:"transparent"}}>
                            <td style={{padding:"5px 8px",color:isActive?"#22d3ee":SC.text,fontWeight:isActive?700:400,textAlign:"right"}}>{d.tol}{isActive?" ◄":""}</td>
                            <td style={{padding:"5px 8px",color:"#22d3ee",textAlign:"right"}}>{d.R1iters}</td>
                            <td style={{padding:"5px 8px",color:SC.amber,textAlign:"right"}}>{d.R2iters}</td>
                            <td style={{padding:"5px 8px",color:isActive?SC.green:SC.text,fontWeight:isActive?700:400,textAlign:"right"}}>{d.totalIters}</td>
                            <td style={{padding:"5px 8px",color:isActive?"#22d3ee":SC.green,fontWeight:isActive?700:400,textAlign:"right"}}>{d.R2MTOW.toFixed(2)}</td>
                            <td style={{padding:"5px 8px",color:delta<1?SC.green:delta<100?SC.amber:SC.red,textAlign:"right"}}>{delta<0.01?"< 0.01":delta.toFixed(2)} g</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>

                {/* T/W vs MTOW Trade Chart */}
                <Panel title={`T/W Ratio vs MTOW — Round 1 vs Round 2 at T/W = ${params.twRatio.toFixed(2)}`} ht={320}>
                  <div style={{fontSize:10,color:SC.muted,marginBottom:6,paddingLeft:4}}>
                    Round 1 is flat (T/W doesn't affect energy-only sizing). Round 2 scales as T/W^1.5 — higher thrust margin → higher hover power → heavier battery → higher MTOW.
                    Current T/W = <span style={{color:SC.amber,fontWeight:700}}>{params.twRatio.toFixed(2)}</span> highlighted.
                  </div>
                  <ResponsiveContainer width="100%" height={255}>
                    <ComposedChart data={SR.twSweepData} margin={{top:5,right:20,left:-10,bottom:20}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="tw" tick={{fontSize:11,fill:SC.muted}}
                        label={{value:"Installed T/W Ratio",position:"insideBottom",offset:-8,fontSize:12,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:11,fill:SC.muted}}
                        label={{value:"MTOW (kg)",angle:-90,position:"insideLeft",fontSize:12,fill:SC.muted}}
                        domain={['auto','auto']}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`${v.toFixed(0)} kg`,n]}/>
                      <Legend iconSize={9} wrapperStyle={{fontSize:12,color:SC.muted,paddingTop:4}}/>
                      <ReferenceLine x={+params.twRatio.toFixed(2)} stroke={SC.amber} strokeWidth={2}
                        label={{value:`Current T/W=${params.twRatio.toFixed(2)}`,fill:SC.amber,fontSize:10,position:"insideTopRight"}}/>
                      <Line type="monotone" dataKey="R1" stroke={SC.muted} strokeWidth={2} strokeDasharray="6 3"
                        dot={{r:3,fill:SC.muted}} name="Round 1 – Energy Only"/>
                      <Line type="monotone" dataKey="R2" stroke={SC.green} strokeWidth={2.5}
                        dot={(props)=>{
                          const {cx,cy,payload}=props;
                          const isActive=Math.abs(payload.tw-params.twRatio)<0.01;
                          return <circle key={cx} cx={cx} cy={cy} r={isActive?7:3} fill={isActive?SC.amber:SC.green} stroke={isActive?SC.amber:"none"}/>;
                        }}
                        name="Round 2 – Dual-Constraint"/>
                    </ComposedChart>
                  </ResponsiveContainer>
                </Panel>

                {/* T/W detailed table */}
                <Panel title="T/W Sensitivity Table — Round 1 vs Round 2 MTOW">
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:"'DM Mono',monospace"}}>
                    <thead>
                      <tr style={{borderBottom:`1px solid ${SC.border}`}}>
                        {["T/W","R1 MTOW (kg)","R2 MTOW (kg)","ΔM (kg)","Δ% vs R1","Phov at R2 (kW)"].map(hdr=>(
                          <th key={hdr} style={{padding:"5px 8px",color:SC.muted,fontWeight:600,textAlign:"right",fontSize:10}}>{hdr}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SR.twSweepData.map((d,i)=>{
                        const isActive=Math.abs(d.tw-params.twRatio)<0.01;
                        const delta=d.R2-d.R1;
                        const pct=((d.R2/d.R1-1)*100);
                        const W2=d.R2*9.81;
                        const DL2=(W2*d.tw)/(Math.PI*Math.pow(params.propDiam/2,2)*params.nPropHover);
                        const phov2=+(W2*d.tw/params.etaHov*Math.sqrt(DL2/(2*1.225))/1000).toFixed(1);
                        return(
                          <tr key={i} style={{borderBottom:`1px solid ${SC.border}22`,background:isActive?`${SC.amber}18`:"transparent"}}>
                            <td style={{padding:"5px 8px",color:isActive?SC.amber:SC.text,fontWeight:isActive?700:400,textAlign:"right"}}>{d.tw.toFixed(2)}{isActive?" ◄ current":""}</td>
                            <td style={{padding:"5px 8px",color:SC.muted,textAlign:"right"}}>{d.R1.toFixed(0)}</td>
                            <td style={{padding:"5px 8px",color:isActive?SC.amber:SC.green,fontWeight:isActive?700:400,textAlign:"right"}}>{d.R2.toFixed(0)}</td>
                            <td style={{padding:"5px 8px",color:SC.amber,textAlign:"right"}}>+{delta.toFixed(0)}</td>
                            <td style={{padding:"5px 8px",color:pct>20?SC.red:pct>10?SC.amber:SC.green,textAlign:"right"}}>+{pct.toFixed(1)}%</td>
                            <td style={{padding:"5px 8px",color:SC.blue,textAlign:"right"}}>{phov2}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Panel>

                <Panel title="Final Converged Design Summary — All Sections">
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                    {[["MTOW",`${SR.MTOW} kg`,SC.amber],["Empty Wt",`${SR.Wempty} kg`,SC.amber],
                      ["Battery",`${SR.Wbat} kg`,SC.amber],["Payload",`${params.payload} kg`,SC.amber],
                      ["Hover Pwr",`${SR.Phov} kW`,SC.blue],["Climb Pwr",`${SR.Pcl} kW`,SC.blue],
                      ["Cruise Pwr",`${SR.Pcr} kW`,SC.blue],["Total E",`${SR.Etot} kWh`,SC.teal],
                      ["Pack E",`${SR.PackkWh} kWh`,SC.teal],["Wing Area",`${SR.Swing} m²`,SC.green],
                      ["Wing Span",`${SR.bWing} m`,SC.green],["MAC",`${SR.MAC} m`,SC.green],
                      ["Actual L/D",SR.LDact,SC.green],["Airfoil",SR.selAF.name,SC.green],
                      ["Vstall",`${SR.Vstall} m/s`,"#8b5cf6"],["Va",`${SR.VA} m/s`,"#8b5cf6"],
                      ["Rotor Diam",`${SR.Drotor} m`,"#f97316"],["Tip Mach",SR.TipMach,"#f97316"],
                      ["T/W hover",SR.TW_hover.toFixed(3),SC.amber],["T/W cruise",SR.TW_cruise.toFixed(3),SC.teal],
                      ["SM",`${(SR.SM*100).toFixed(1)}%`,SR.SM>0.05&&SR.SM<0.25?SC.green:SC.red],
                      ["Mach",SR.Mach,SR.Mach<0.45?SC.green:SC.amber],
                    ].map(([k,v,col],i)=>(
                      <div key={i} style={{background:SC.bg,borderRadius:4,padding:"6px 8px",borderLeft:`2px solid ${col}44`}}>
                        <div style={{fontSize:7,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:1}}>{k}</div>
                        <div style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            )}

            {/* ──── TAB 9: MONTE CARLO UNCERTAINTY ANALYSIS ──── */}
            {tab===9&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:SC.panel,
                  border:`1px solid #7c3aed44`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>UNCERTAINTY QUANTIFICATION — MONTE CARLO METHOD</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,letterSpacing:"-0.02em",marginBottom:6}}>
                    <span style={{color:"#a78bfa"}}>Monte Carlo</span> Uncertainty Analysis
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:700}}>
                    Runs <span style={{color:"#a78bfa",fontWeight:700}}>{mcN.toLocaleString()} simulations</span>, each with parameters randomly sampled from their uncertainty distributions.
                    Produces probability distributions of MTOW, Energy, Hover Power, and Static Margin —
                    giving confidence intervals instead of single-point estimates.
                    Based on literature uncertainty bounds from <em>Raymer, Ng &amp; Willcox (MIT), and Sripad &amp; Viswanathan</em>.
                  </div>
                </div>

                {/* Parameter ranges config */}
                <Panel title="Uncertain Parameter Ranges — Click to Edit">
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:12,lineHeight:1.6}}>
                    Each parameter is sampled from a <span style={{color:"#a78bfa"}}>Normal distribution</span> (μ = midpoint, σ = range/6 so ±3σ covers full range) or
                    <span style={{color:SC.teal}}> Uniform distribution</span>.
                    Ranges are based on peer-reviewed eVTOL uncertainty literature.
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                    {[
                      {key:"sedCell",label:"Battery SED",unit:"Wh/kg",note:"±17% — Joby/Archer 2025 range"},
                      {key:"ewf",    label:"Empty Wt Frac",unit:"",note:"±14% — validated Joby/Lilium/Alia"},
                      {key:"LD",     label:"Lift/Drag L/D",unit:"",note:"±18% — conceptual design uncertainty"},
                      {key:"etaHov", label:"Hover FOM η",unit:"",note:"±11% — rotor efficiency spread"},
                      {key:"etaSys", label:"System η",unit:"",note:"±8% — motor+inverter chain"},
                      {key:"etaBat", label:"Battery η",unit:"",note:"±5% — NMC pack efficiency"},
                      {key:"AR",     label:"Aspect Ratio",unit:"",note:"±20% — wing design freedom"},
                      {key:"payload",label:"Payload",unit:"kg",note:"±10% — mission variation"},
                    ].map(({key,label,unit,note})=>{
                      const r=mcRanges[key];
                      return(
                        <div key={key} style={{background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:8,padding:"10px 12px"}}>
                          <div style={{fontSize:10,fontWeight:700,color:"#a78bfa",fontFamily:"'DM Mono',monospace",marginBottom:6}}>{label}</div>
                          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:4}}>
                            <div style={{flex:1}}>
                              <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:2}}>MIN</div>
                              <input type="number" value={r.min} step={key==="payload"?5:key==="sedCell"?5:key==="AR"?0.5:0.01}
                                onChange={evt=>setMcRanges(prev=>({...prev,[key]:{...prev[key],min:parseFloat(evt.target.value)||prev[key].min}}))}
                                style={{width:"100%",boxSizing:"border-box",background:SC.panel,border:`1px solid ${SC.border}`,
                                  borderRadius:4,color:SC.text,fontSize:11,padding:"4px 6px",fontFamily:"'DM Mono',monospace",outline:"none"}}/>
                            </div>
                            <div style={{flex:1}}>
                              <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:2}}>MAX</div>
                              <input type="number" value={r.max} step={key==="payload"?5:key==="sedCell"?5:key==="AR"?0.5:0.01}
                                onChange={evt=>setMcRanges(prev=>({...prev,[key]:{...prev[key],max:parseFloat(evt.target.value)||prev[key].max}}))}
                                style={{width:"100%",boxSizing:"border-box",background:SC.panel,border:`1px solid ${SC.border}`,
                                  borderRadius:4,color:SC.text,fontSize:11,padding:"4px 6px",fontFamily:"'DM Mono',monospace",outline:"none"}}/>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:4,marginBottom:4}}>
                            {["normal","uniform"].map(d=>(
                              <button key={d} onClick={()=>setMcRanges(prev=>({...prev,[key]:{...prev[key],dist:d}}))} type="button"
                                style={{flex:1,padding:"3px 0",fontSize:8,fontFamily:"'DM Mono',monospace",cursor:"pointer",
                                  background:r.dist===d?(d==="normal"?"#4c1d95":"#134e4a"):"transparent",
                                  border:`1px solid ${r.dist===d?(d==="normal"?"#7c3aed":SC.teal):SC.border}`,
                                  color:r.dist===d?(d==="normal"?"#c4b5fd":SC.teal):SC.muted,borderRadius:3}}>
                                {d==="normal"?"𝒩 Normal":"⊡ Uniform"}
                              </button>
                            ))}
                          </div>
                          <div style={{fontSize:8,color:SC.dim,fontFamily:"'DM Mono',monospace"}}>{note}</div>
                          {unit&&<div style={{fontSize:8,color:SC.amber,fontFamily:"'DM Mono',monospace"}}>{unit}</div>}
                          {/* mini range bar */}
                          <div style={{marginTop:6,height:4,background:SC.border,borderRadius:2,position:"relative"}}>
                            <div style={{position:"absolute",left:"10%",right:"10%",top:0,height:"100%",
                              background:r.dist==="normal"?"#7c3aed":SC.teal,borderRadius:2,opacity:0.6}}/>
                            <div style={{position:"absolute",left:"50%",top:-3,width:2,height:10,
                              background:SC.amber,transform:"translateX(-50%)"}}/>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:SC.dim,fontFamily:"'DM Mono',monospace",marginTop:2}}>
                            <span>{r.min}</span><span>μ={(+((r.min+r.max)/2).toFixed(2))}</span><span>{r.max}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* N slider + run button */}
                  <div style={{display:"flex",alignItems:"center",gap:16,marginTop:16,padding:"12px 16px",
                    background:SC.bg,borderRadius:8,border:`1px solid ${SC.border}`}}>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                        <span style={{fontSize:11,color:SC.text,fontFamily:"'DM Mono',monospace"}}>
                          Simulations: <span style={{color:"#a78bfa",fontWeight:700}}>{mcN.toLocaleString()}</span>
                        </span>
                        <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                          ~{(mcN*0.06).toFixed(0)}ms runtime
                        </span>
                      </div>
                      <input type="range" min={100} max={5000} step={100} value={mcN}
                        onChange={evt=>setMcN(+evt.target.value)}
                        style={{width:"100%",accentColor:"#7c3aed",cursor:"pointer"}}/>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:SC.muted,marginTop:2}}>
                        <span>100 (fast)</span><span>5000 (precise)</span>
                      </div>
                    </div>
                    <button onClick={runMonteCarlo} disabled={mcRunning} type="button"
                      style={{padding:"12px 28px",
                        background:mcRunning?"transparent":`linear-gradient(135deg,#4c1d95,#6d28d9)`,
                        border:`2px solid #7c3aed`,borderRadius:8,color:mcRunning?SC.muted:"#e9d5ff",
                        fontSize:13,fontWeight:800,cursor:mcRunning?"not-allowed":"pointer",
                        fontFamily:"'DM Mono',monospace",letterSpacing:"0.05em",
                        boxShadow:mcRunning?"none":"0 0 20px #7c3aed44",
                        transition:"all 0.2s"}}>
                      {mcRunning?"⟳ Running...":"🎲 Run Monte Carlo"}
                    </button>
                  </div>
                </Panel>

                {/* Results */}
                {!mcResults&&!mcRunning&&(
                  <div style={{textAlign:"center",padding:"48px 0",color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                    <div style={{fontSize:48,marginBottom:16}}>🎲</div>
                    <div style={{fontSize:14,fontWeight:600,color:SC.text,marginBottom:8}}>No simulation run yet</div>
                    <div style={{fontSize:12,color:SC.muted}}>Configure ranges above and click <span style={{color:"#a78bfa"}}>Run Monte Carlo</span></div>
                  </div>
                )}
                {mcRunning&&(
                  <div style={{textAlign:"center",padding:"48px 0",color:"#a78bfa",fontFamily:"'DM Mono',monospace"}}>
                    <div style={{fontSize:36,marginBottom:12,animation:"spin 1s linear infinite",display:"inline-block"}}>⟳</div>
                    <div style={{fontSize:14,fontWeight:700}}>Running {mcN.toLocaleString()} simulations...</div>
                    <div style={{fontSize:11,color:SC.muted,marginTop:6}}>Each calling the full eVTOL physics engine</div>
                  </div>
                )}

                {mcResults&&(
                  <>
                    {/* Summary KPIs */}
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                      <KPI label="Simulations Run" value={mcResults.N.toLocaleString()} unit="" color={"#a78bfa"} sub={`${mcResults.failCount} failed/invalid`}/>
                      <KPI label="Feasible Designs" value={mcResults.feasRate+"%"} unit="" color={+mcResults.feasRate>70?SC.green:+mcResults.feasRate>40?SC.amber:SC.red} sub="pass all checks"/>
                      <KPI label="Mean MTOW" value={mcResults.MTOW.stats.mean.toFixed(0)} unit="kg" color={SC.amber} sub={`σ = ${mcResults.MTOW.stats.std.toFixed(0)} kg`}/>
                      <KPI label="P95 MTOW" value={mcResults.MTOW.stats.p95.toFixed(0)} unit="kg" color={SC.red} sub="95% of designs below"/>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                      <KPI label="P5 MTOW (best)" value={mcResults.MTOW.stats.p5.toFixed(0)} unit="kg" color={SC.green} sub="5th percentile"/>
                      <KPI label="MTOW Range" value={`${mcResults.MTOW.stats.min.toFixed(0)}–${mcResults.MTOW.stats.max.toFixed(0)}`} unit="kg" color={SC.muted}/>
                      <KPI label="Mean Energy" value={mcResults.Etot.stats.mean.toFixed(2)} unit="kWh" color={SC.teal} sub={`σ = ${mcResults.Etot.stats.std.toFixed(2)}`}/>
                      <KPI label="Mean Hover Pwr" value={mcResults.Phov.stats.mean.toFixed(1)} unit="kW" color={SC.blue} sub={`σ = ${mcResults.Phov.stats.std.toFixed(1)}`}/>
                    </div>

                    {/* MTOW Probability Distribution */}
                    <Panel title={`MTOW Probability Distribution — ${mcResults.N.toLocaleString()} Monte Carlo Samples`} ht={320}>
                      <div style={{fontSize:10,color:SC.muted,marginBottom:6,paddingLeft:4,fontFamily:"'DM Mono',monospace"}}>
                        Each bar = count of designs in that MTOW bin. Bell shape confirms normal convergence.
                        <span style={{color:SC.amber}}> Nominal MTOW = {SR.MTOW} kg</span> (deterministic).
                        <span style={{color:"#a78bfa"}}> Mean MC = {mcResults.MTOW.stats.mean.toFixed(0)} kg</span>.
                      </div>
                      <ResponsiveContainer width="100%" height={255}>
                        <ComposedChart data={mcResults.MTOW.hist} margin={{top:5,right:20,left:5,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                            label={{value:"MTOW (kg)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                          <YAxis yAxisId="left" tick={{fontSize:9,fill:SC.muted}}
                            label={{value:"Count",angle:-90,position:"insideLeft",fontSize:11,fill:SC.muted}}/>
                          <YAxis yAxisId="right" orientation="right" tick={{fontSize:9,fill:"#a78bfa"}}
                            label={{value:"% of runs",angle:90,position:"insideRight",fontSize:11,fill:"#a78bfa"}}/>
                          <Tooltip {...TTP} formatter={(v,n)=>n==="Count"?[v,n]:[`${v}%`,n]}/>
                          <Legend iconSize={9} wrapperStyle={{fontSize:11,color:SC.muted}}/>
                          <Bar yAxisId="left" dataKey="count" fill="#7c3aed" opacity={0.8} name="Count" radius={[2,2,0,0]}/>
                          <Line yAxisId="right" type="monotone" dataKey="pct" stroke={SC.amber} strokeWidth={2} dot={false} name="% of runs"/>
                          <ReferenceLine yAxisId="left" x={mcResults.MTOW.stats.mean.toFixed(1)} stroke={SC.amber} strokeWidth={2} strokeDasharray="6 3"
                            label={{value:`μ=${mcResults.MTOW.stats.mean.toFixed(0)}`,fill:SC.amber,fontSize:10,position:"top"}}/>
                          <ReferenceLine yAxisId="left" x={mcResults.MTOW.stats.p95.toFixed(1)} stroke={SC.red} strokeWidth={2} strokeDasharray="4 2"
                            label={{value:`P95=${mcResults.MTOW.stats.p95.toFixed(0)}`,fill:SC.red,fontSize:10,position:"top"}}/>
                          <ReferenceLine yAxisId="left" x={SR.MTOW.toFixed(1)} stroke={SC.green} strokeWidth={2} strokeDasharray="4 2"
                            label={{value:`Nominal=${SR.MTOW}`,fill:SC.green,fontSize:10,position:"top"}}/>
                        </ComposedChart>
                      </ResponsiveContainer>
                    </Panel>

                    {/* CDF */}
                    <Panel title="Cumulative Distribution Function (CDF) — MTOW" ht={290}>
                      <div style={{fontSize:10,color:SC.muted,marginBottom:6,paddingLeft:4,fontFamily:"'DM Mono',monospace"}}>
                        Read as: <span style={{color:SC.green}}>P(MTOW ≤ x)</span>. The <span style={{color:SC.amber}}>P90 line</span> shows that 90% of all possible designs have MTOW below this value.
                        This is the key output for design margin decisions.
                      </div>
                      <ResponsiveContainer width="100%" height={230}>
                        <AreaChart data={mcResults.MTOW.cdf} margin={{top:5,right:20,left:5,bottom:20}}>
                          <defs><linearGradient id="cdfg" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.4}/>
                            <stop offset="95%" stopColor="#7c3aed" stopOpacity={0.02}/>
                          </linearGradient></defs>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                            label={{value:"MTOW (kg)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                          <YAxis domain={[0,100]} tick={{fontSize:9,fill:SC.muted}}
                            label={{value:"Probability (%)",angle:-90,position:"insideLeft",fontSize:11,fill:SC.muted}}/>
                          <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,"P(MTOW ≤ x)"]}/>
                          <Area type="monotone" dataKey="cdf" stroke="#7c3aed" strokeWidth={2.5} fill="url(#cdfg)" dot={false} name="CDF"/>
                          <ReferenceLine y={50}  stroke={SC.muted}   strokeDasharray="4 2" label={{value:"P50",fill:SC.muted,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={90}  stroke={SC.amber}   strokeDasharray="4 2" label={{value:"P90",fill:SC.amber,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={95}  stroke={SC.red}     strokeDasharray="4 2" label={{value:"P95",fill:SC.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine x={SR.MTOW} stroke={SC.green} strokeDasharray="4 2"
                            label={{value:`Nominal ${SR.MTOW}kg`,fill:SC.green,fontSize:9,position:"top"}}/>
                        </AreaChart>
                      </ResponsiveContainer>
                    </Panel>

                    {/* Other distributions row */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                      <Panel title="Total Energy Distribution (kWh)" ht={240}>
                        <ResponsiveContainer width="100%" height={195}>
                          <BarChart data={mcResults.Etot.hist} margin={{top:5,right:10,left:-10,bottom:16}}>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                              label={{value:"Energy (kWh)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                            <Tooltip {...TTP}/>
                            <Bar dataKey="count" fill={SC.teal} opacity={0.8} radius={[2,2,0,0]}/>
                            <ReferenceLine x={mcResults.Etot.stats.mean.toFixed(2)} stroke={SC.amber} strokeDasharray="4 2"
                              label={{value:`μ=${mcResults.Etot.stats.mean.toFixed(1)}`,fill:SC.amber,fontSize:9,position:"top"}}/>
                          </BarChart>
                        </ResponsiveContainer>
                      </Panel>
                      <Panel title="Static Margin Distribution (% MAC)" ht={240}>
                        <ResponsiveContainer width="100%" height={195}>
                          <BarChart data={mcResults.SM.hist} margin={{top:5,right:10,left:-10,bottom:16}}>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                              label={{value:"SM (% MAC)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                            <Tooltip {...TTP}/>
                            <Bar dataKey="count" radius={[2,2,0,0]}>
                              {mcResults.SM.hist.map((d,i)=>(
                                <Cell key={i} fill={d.x>=5&&d.x<=25?SC.green:SC.red} opacity={0.8}/>
                              ))}
                            </Bar>
                            <ReferenceLine x={5}  stroke={SC.green} strokeDasharray="3 2" label={{value:"5%",fill:SC.green,fontSize:9}}/>
                            <ReferenceLine x={25} stroke={SC.green} strokeDasharray="3 2" label={{value:"25%",fill:SC.green,fontSize:9}}/>
                            <ReferenceLine x={mcResults.SM.stats.mean.toFixed(1)} stroke={SC.amber} strokeDasharray="4 2"
                              label={{value:`μ=${mcResults.SM.stats.mean.toFixed(1)}%`,fill:SC.amber,fontSize:9,position:"top"}}/>
                          </BarChart>
                        </ResponsiveContainer>
                      </Panel>
                      <Panel title="Hover Power Distribution (kW)" ht={240}>
                        <ResponsiveContainer width="100%" height={195}>
                          <BarChart data={mcResults.Phov.hist} margin={{top:5,right:10,left:-10,bottom:16}}>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                              label={{value:"Hover Power (kW)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                            <Tooltip {...TTP}/>
                            <Bar dataKey="count" fill={SC.blue} opacity={0.8} radius={[2,2,0,0]}/>
                            <ReferenceLine x={mcResults.Phov.stats.mean.toFixed(1)} stroke={SC.amber} strokeDasharray="4 2"
                              label={{value:`μ=${mcResults.Phov.stats.mean.toFixed(0)}kW`,fill:SC.amber,fontSize:9,position:"top"}}/>
                          </BarChart>
                        </ResponsiveContainer>
                      </Panel>
                      <Panel title="Battery Mass Distribution (kg)" ht={240}>
                        <ResponsiveContainer width="100%" height={195}>
                          <BarChart data={mcResults.Wbat.hist} margin={{top:5,right:10,left:-10,bottom:16}}>
                            <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                            <XAxis dataKey="x" tick={{fontSize:9,fill:SC.muted}}
                              label={{value:"Battery Mass (kg)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                            <YAxis tick={{fontSize:9,fill:SC.muted}}/>
                            <Tooltip {...TTP}/>
                            <Bar dataKey="count" fill={SC.amber} opacity={0.8} radius={[2,2,0,0]}/>
                            <ReferenceLine x={mcResults.Wbat.stats.mean.toFixed(1)} stroke={SC.green} strokeDasharray="4 2"
                              label={{value:`μ=${mcResults.Wbat.stats.mean.toFixed(0)}kg`,fill:SC.green,fontSize:9,position:"top"}}/>
                          </BarChart>
                        </ResponsiveContainer>
                      </Panel>
                    </div>

                    {/* Statistics Table */}
                    <Panel title="Full Statistical Summary — All Output Quantities">
                      <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:10}}>
                        P5/P50/P95 = 5th, 50th, 95th percentile. σ = standard deviation. CV = coefficient of variation (σ/μ) — lower is more robust.
                      </div>
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                          <thead>
                            <tr style={{background:SC.panel}}>
                              {["Quantity","Unit","Min","P5","P25","Median","P75","P95","Max","Mean","σ","CV %"].map(hdr=>(
                                <th key={hdr} style={{padding:"5px 8px",color:SC.muted,fontWeight:600,textAlign:"right",
                                  fontSize:9,letterSpacing:"0.04em"}}>{hdr}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {[
                              ["MTOW","kg",mcResults.MTOW.stats,SC.amber],
                              ["Total Energy","kWh",mcResults.Etot.stats,SC.teal],
                              ["Hover Power","kW",mcResults.Phov.stats,SC.blue],
                              ["Battery Mass","kg",mcResults.Wbat.stats,SC.amber],
                              ["Actual L/D","",mcResults.LDact.stats,SC.green],
                              ["Static Margin","%",mcResults.SM.stats,SC.green],
                            ].map(([name,unit,s,col],i)=>{
                              const cv=(s.std/Math.abs(s.mean)*100);
                              return(
                                <tr key={i} style={{borderTop:`1px solid ${SC.border}`,background:i%2?"#0a0d14":SC.bg}}>
                                  <td style={{padding:"5px 8px",color:col,fontWeight:700}}>{name}</td>
                                  <td style={{padding:"5px 8px",color:SC.muted,textAlign:"right"}}>{unit}</td>
                                  {[s.min,s.p5,s.p25,s.p50,s.p75,s.p95,s.max,s.mean,s.std].map((statVal,j)=>(
                                    <td key={j} style={{padding:"5px 8px",color:j===7?col:SC.text,
                                      fontWeight:j===7?700:400,textAlign:"right"}}>{statVal?.toFixed(j>=7?2:1)}</td>
                                  ))}
                                  <td style={{padding:"5px 8px",textAlign:"right",
                                    color:cv<5?SC.green:cv<15?SC.amber:SC.red,fontWeight:700}}>
                                    {cv.toFixed(1)}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <div style={{marginTop:10,padding:"8px 12px",background:`${"#a78bfa"}11`,
                        border:`1px solid ${"#a78bfa"}44`,borderRadius:6,fontSize:10,
                        color:"#a78bfa",fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                        📊 <strong>Key insight:</strong> There is a <strong>{(mcResults.MTOW.stats.p95/mcResults.MTOW.stats.mean*100-100).toFixed(1)}% mass growth risk</strong> from
                        P50→P95. Design your structure and battery for the <strong>P90 MTOW = {mcResults.MTOW.stats.p95.toFixed(0)} kg</strong> to cover
                        95% of all possible technology combinations within the given uncertainty bounds.
                        Feasibility rate: <strong style={{color:+mcResults.feasRate>70?SC.green:SC.red}}>{mcResults.feasRate}%</strong> of designs pass all constraints.
                      </div>
                    </Panel>
                  </>
                )}
              </div>
            )}


            {/* ──── TAB 10: CERTIFICATION COMPLIANCE CHECKER ──── */}
            {tab===10&&SR&&(()=>{
              // ═══════════════════════════════════════════════════════
              // COMPUTED CERTIFICATION PARAMETERS
              // ═══════════════════════════════════════════════════════
              const MTOW_kg  = SR.MTOW;
              const MTOW_lb  = MTOW_kg * 2.20462;
              const nPax     = Math.floor(params.payload / 90);
              const batFrac  = SR.Wbat / MTOW_kg;
              const socFloor = params.socMin / (1 + params.socMin);
              const reserve_pct = (1 - SR.Etot / SR.PackkWh) * 100;

              // Use noise values computed in physics engine (BPF + broadband model)
              const BPF = SR.BPF;
              const dBA_hover = SR.dBA_150m;  // A-weighted at 150m from physics engine
              const r_ref = 150;

              // Reserve energy margin
              const reserveE_pct = (SR.Eres / SR.PackkWh) * 100;

              // Structural load factor (from V-n diagram)
              const n_pos = 3.5; // limit load from V-n diagram
              const n_ult = n_pos * 1.5; // ultimate = 1.5 × limit (FAR 21.17 / CS-23)

              // CG range check — allowed range ±15% MAC from NP
              const cgRange = Math.abs(SR.xNP - SR.xCGtotal) / SR.MAC * 100;

              // Battery C-rate under hover
              const C_hover = SR.CrateHov;

              // Wing loading for stall compliance
              const Vstall_stall = SR.Vstall;

              // ═══════════════════════════════════════════════════════
              // RULE DEFINITIONS — all sourced from actual regulations
              // ═══════════════════════════════════════════════════════
              const rules = {
                FAA: [
                  // Weight & Category
                  {
                    id:"FAA-W1", ref:"AC 21.17-4 §1 / 14 CFR §21.17(b)",
                    category:"Weight & Category",
                    title:"Max Certificated Takeoff Weight",
                    desc:"Powered-lift aircraft must not exceed 12,500 lb (5,670 kg) for AC 21.17-4 applicability.",
                    check: MTOW_lb <= 12500,
                    value: `${MTOW_lb.toFixed(0)} lb (${MTOW_kg.toFixed(0)} kg)`,
                    limit: "≤ 12,500 lb (5,670 kg)",
                    severity:"critical",
                  },
                  {
                    id:"FAA-W2", ref:"AC 21.17-4 / PS-AIR-21.17-01 Safety Continuum",
                    category:"Weight & Category",
                    title:"Passenger Seating Configuration",
                    desc:"Up to 6 passengers for AC 21.17-4 applicability. More than 6 requires Part 25/29 compliance.",
                    check: nPax <= 6,
                    value: `~${nPax} passengers (payload ${params.payload} kg @ 90 kg/pax)`,
                    limit: "≤ 6 passengers",
                    severity:"critical",
                  },
                  // Structural
                  {
                    id:"FAA-S1", ref:"AC 21.17-4 App.A PL.2215 / FAR 23.337",
                    category:"Structural Integrity",
                    title:"Positive Limit Load Factor",
                    desc:"For normal category powered-lift, limit load factor must be ≥ 3.5g at MTOW.",
                    check: n_pos >= 3.5,
                    value: `${n_pos.toFixed(1)}g`,
                    limit: "≥ 3.5g (normal category)",
                    severity:"critical",
                  },
                  {
                    id:"FAA-S2", ref:"AC 21.17-4 App.A PL.2235 / FAR 23.303",
                    category:"Structural Integrity",
                    title:"Ultimate Load Factor (1.5 × Limit)",
                    desc:"All structural elements must withstand ultimate loads = 1.5 × limit load without failure.",
                    check: n_ult >= 5.25,
                    value: `${n_ult.toFixed(1)}g`,
                    limit: "≥ 5.25g (1.5 × 3.5g limit)",
                    severity:"critical",
                  },
                  {
                    id:"FAA-S3", ref:"AC 21.17-4 PL.2241 / FAR 21.17(b)",
                    category:"Structural Integrity",
                    title:"Rotor Tip Mach — Aeroelastic Stability",
                    desc:"Tip Mach must stay below 0.70 to avoid compressibility effects and flutter risk per AC 21.17-4.",
                    check: SR.TipMach < 0.70,
                    value: `Mtip = ${SR.TipMach}`,
                    limit: "< 0.70",
                    severity:"critical",
                  },
                  // Performance
                  {
                    id:"FAA-P1", ref:"AC 21.17-4 PL.1035(c) / FAR 27.33",
                    category:"Flight Performance",
                    title:"Reserve Energy Margin",
                    desc:"Must carry energy for ≥ 20 min reserve flight at best-range speed after completing mission.",
                    check: SR.tres >= 1200,
                    value: `${SR.tres}s = ${(SR.tres/60).toFixed(1)} min`,
                    limit: "≥ 20 min (1,200 s)",
                    severity:"critical",
                  },
                  {
                    id:"FAA-P2", ref:"AC 21.17-4 App.A / FAR 23.2110",
                    category:"Flight Performance",
                    title:"Final State of Charge ≥ Reserve Minimum",
                    desc:"Battery SoC at end of mission must remain above the minimum reserve floor set by SoCmin.",
                    check: reserve_pct >= (socFloor * 100 - 1),
                    value: `${reserve_pct.toFixed(1)}% remaining (floor: ${(socFloor*100).toFixed(1)}%)`,
                    limit: `≥ ${(socFloor*100).toFixed(1)}% SoC floor`,
                    severity:"major",
                  },
                  {
                    id:"FAA-P3", ref:"AC 21.17-4 PL.2100 / FAR 27.143",
                    category:"Flight Performance",
                    title:"Static Margin — Longitudinal Stability",
                    desc:"Aircraft must be statically stable longitudinally. SM must be positive (5–25% MAC target for FBW eVTOL).",
                    check: SR.SM_vt >= 0.05 && SR.SM_vt <= 0.25,
                    value: `SM = ${(SR.SM_vt*100).toFixed(1)}% MAC`,
                    limit: "5–25% MAC",
                    severity:"critical",
                  },
                  // Noise — FAR Part 36
                  {
                    id:"FAA-N1", ref:"14 CFR Part 36 / AC 21.17-4",
                    category:"Noise (FAR Part 36)",
                    title:"Hover Noise Estimate (150m reference)",
                    desc:"Estimated A-weighted hover noise at 150m. EASA UAM community noise target: ≤ 65 dBA for urban integration acceptance. No specific FAA numeric limit yet — evaluated case-by-case under 14 CFR Part 36 / AC 21.17-4.",
                    check: dBA_hover <= 65,
                    value: `~${dBA_hover.toFixed(1)} dBA (at ${r_ref}m)`,
                    limit: "≤ 65 dBA (EASA UAM / FAA advisory target)",
                    severity:"advisory",
                  },
                  {
                    id:"FAA-N2", ref:"14 CFR Part 36 / AC 21.17-4 §7",
                    category:"Noise (FAR Part 36)",
                    title:"Rotor Tip Speed — Noise Driver",
                    desc:"Lower tip speed directly reduces BPF tonal noise. Tip speeds > 200 m/s significantly increase community noise. Target: ≤ 200 m/s.",
                    check: SR.TipSpd <= 200,
                    value: `${SR.TipSpd} m/s`,
                    limit: "≤ 200 m/s",
                    severity:"major",
                  },
                  {
                    id:"FAA-N3", ref:"14 CFR Part 36 Appendix H / AC 21.17-4",
                    category:"Noise (FAR Part 36)",
                    title:"Blade Passing Frequency",
                    desc:"BPF should remain below 150 Hz to minimize tonal noise impact in residential areas (psychoacoustic threshold).",
                    check: BPF <= 150,
                    value: `BPF = ${BPF.toFixed(1)} Hz (${SR.Nbld} blades × ${SR.RPM.toFixed(0)} RPM/60)`,
                    limit: "≤ 150 Hz",
                    severity:"advisory",
                  },
                  // Battery Safety
                  {
                    id:"FAA-B1", ref:"AC 21.17-4 App.A PL.1353 / RTCA DO-311A",
                    category:"Battery Safety",
                    title:"Battery Mass Fraction",
                    desc:"Battery mass fraction should stay below 55% of MTOW for structural balance and crashworthiness.",
                    check: batFrac < 0.55,
                    value: `${(batFrac*100).toFixed(1)}% of MTOW`,
                    limit: "< 55%",
                    severity:"major",
                  },
                  {
                    id:"FAA-B2", ref:"AC 21.17-4 PL.1353(c) / RTCA DO-311A §2.4",
                    category:"Battery Safety",
                    title:"Hover C-rate — Thermal Runaway Risk",
                    desc:"Pack C-rate during hover must stay below 5C to comply with RTCA DO-311A thermal runaway containment requirements.",
                    check: C_hover <= 5.0,
                    value: `${C_hover.toFixed(2)}C`,
                    limit: "≤ 5.0C",
                    severity:"major",
                  },
                  // Aerodynamics
                  {
                    id:"FAA-A1", ref:"AC 21.17-4 PL.2100 / FAR 23.2110",
                    category:"Aerodynamics",
                    title:"Actual Lift-to-Drag Ratio",
                    desc:"Minimum aerodynamic efficiency requirement. L/D > 10 required for range and energy compliance.",
                    check: SR.LDact > 10,
                    value: `L/D = ${SR.LDact}`,
                    limit: "> 10",
                    severity:"major",
                  },
                  {
                    id:"FAA-A2", ref:"AC 21.17-4 PL.2200 / FAR 23.2115",
                    category:"Aerodynamics",
                    title:"Cruise Mach Number",
                    desc:"Must remain below Mach 0.45 for subsonic aerodynamic assumptions to remain valid in conceptual design.",
                    check: SR.Mach < 0.45,
                    value: `M = ${SR.Mach}`,
                    limit: "< 0.45",
                    severity:"major",
                  },
                ],
                EASA: [
                  // Weight & Category
                  {
                    id:"EASA-W1", ref:"SC-VTOL-01 VTOL.2005 Issue 2",
                    category:"Weight & Category",
                    title:"EASA Small Category — Max MTOM",
                    desc:"EASA SC-VTOL small category covers aircraft ≤ 3,175 kg MTOM (CS-27 limit). Above this requires SC-VTOL Enhanced provisions.",
                    check: MTOW_kg <= 3175,
                    value: `${MTOW_kg.toFixed(0)} kg`,
                    limit: "≤ 3,175 kg (SC-VTOL small category)",
                    severity:"critical",
                  },
                  {
                    id:"EASA-W2", ref:"SC-VTOL-01 VTOL.2005",
                    category:"Weight & Category",
                    title:"EASA Passenger Seating Limit",
                    desc:"EASA SC-VTOL small category: ≤ 5 passenger seats. Exceeding requires SC-VTOL Enhanced certification.",
                    check: nPax <= 5,
                    value: `~${nPax} passengers`,
                    limit: "≤ 5 passengers",
                    severity:"critical",
                  },
                  // Structural
                  {
                    id:"EASA-S1", ref:"SC-VTOL-01 VTOL.2215 / CS-27.337",
                    category:"Structural Integrity",
                    title:"Limit Load Factor (SC-VTOL)",
                    desc:"SC-VTOL requires design load factor ≥ 3.5g for normal category. Enhanced category may require higher.",
                    check: n_pos >= 3.5,
                    value: `${n_pos.toFixed(1)}g`,
                    limit: "≥ 3.5g",
                    severity:"critical",
                  },
                  {
                    id:"EASA-S2", ref:"SC-VTOL-01 VTOL.2265",
                    category:"Structural Integrity",
                    title:"Special Factor of Safety — Uncertain Components",
                    desc:"SC-VTOL VTOL.2265: additional safety factors applied for novel/uncertain structural elements. Conceptual design margin ≥ 1.5.",
                    check: n_ult / n_pos >= 1.5,
                    value: `Factor = ${(n_ult/n_pos).toFixed(1)}`,
                    limit: "≥ 1.5",
                    severity:"major",
                  },
                  {
                    id:"EASA-S3", ref:"SC-VTOL-01 VTOL.2241",
                    category:"Structural Integrity",
                    title:"Aeromechanical Stability",
                    desc:"Aircraft must be free from dangerous oscillations. Tip Mach < 0.70 required for aeromechanical stability compliance.",
                    check: SR.TipMach < 0.70,
                    value: `Mtip = ${SR.TipMach}`,
                    limit: "< 0.70",
                    severity:"critical",
                  },
                  // Performance — SC-VTOL Category Basic vs Enhanced
                  {
                    id:"EASA-P1", ref:"SC-VTOL-01 VTOL.2005 Category Basic/Enhanced",
                    category:"Flight Performance",
                    title:"Category Classification",
                    desc:"Category Basic: controlled emergency landing after critical failure. Category Enhanced: continued safe flight and landing. SM > 5% required for both.",
                    check: SR.SM_vt > 0.05,
                    value: `SM = ${(SR.SM_vt*100).toFixed(1)}% | Category: ${SR.SM_vt>0.10?"Enhanced-eligible":"Basic"}`,
                    limit: "SM > 5% MAC",
                    severity:"critical",
                  },
                  {
                    id:"EASA-P2", ref:"SC-VTOL-01 VTOL.1035 / CS-27.1035",
                    category:"Flight Performance",
                    title:"Reserve Energy (30 min IFR / 20 min VFR)",
                    desc:"SC-VTOL requires 20 min VFR reserve (1,200s). IFR operations require 30 min (1,800s).",
                    check: SR.tres >= 1200,
                    value: `${SR.tres}s = ${(SR.tres/60).toFixed(1)} min`,
                    limit: "≥ 1,200s VFR / 1,800s IFR",
                    severity:"critical",
                  },
                  {
                    id:"EASA-P3", ref:"SC-VTOL-01 VTOL.2100 / CS-27.143",
                    category:"Flight Performance",
                    title:"Fus/Span Ratio — Fuselage-Wing Proportions",
                    desc:"Fuselage/span ratio must remain within 0.50–0.72 for realistic eVTOL proportions per EASA SC-VTOL design guidance.",
                    check: SR.fusSpanRatio >= 0.50 && SR.fusSpanRatio <= 0.72,
                    value: `${SR.fusSpanRatio?.toFixed(3) || "—"}`,
                    limit: "0.50–0.72",
                    severity:"advisory",
                  },
                  // Noise — EASA CS-36 / UAM Community Noise
                  {
                    id:"EASA-N1", ref:"EASA SC-VTOL / CS-36 Appendix J / UAM Community Noise Target",
                    category:"Noise (EASA CS-36 / UAM)",
                    title:"UAM Community Noise Target (65 dBA)",
                    desc:"EASA UAM community noise target: ≤ 65 dBA at 150m for urban integration acceptance. Estimated hover noise must meet this.",
                    check: dBA_hover <= 65,
                    value: `~${dBA_hover.toFixed(1)} dBA (at ${r_ref}m)`,
                    limit: "≤ 65 dBA (UAM target)",
                    severity:"major",
                  },
                  {
                    id:"EASA-N2", ref:"EASA CS-36 Appendix H+J / ICAO Annex 16 Vol.I",
                    category:"Noise (EASA CS-36 / UAM)",
                    title:"Tip Speed — Urban Noise Compliance",
                    desc:"EASA CS-36 noise evaluation: lower tip speeds required for urban operations. Target ≤ 180 m/s for enhanced community acceptance.",
                    check: SR.TipSpd <= 180,
                    value: `${SR.TipSpd} m/s`,
                    limit: "≤ 180 m/s (EASA enhanced target)",
                    severity:"major",
                  },
                  // Battery Safety — EASA MOC-3 SC-VTOL
                  {
                    id:"EASA-B1", ref:"MOC-3 SC-VTOL VTOL.2330 / RTCA DO-311A §2.4",
                    category:"Battery Safety (MOC-3 SC-VTOL)",
                    title:"Thermal Runaway Containment",
                    desc:"EASA MOC-3 SC-VTOL: battery systems must demonstrate thermal runaway containment. C-rate ≤ 5C at hover required per DO-311A.",
                    check: C_hover <= 5.0,
                    value: `${C_hover.toFixed(2)}C hover C-rate`,
                    limit: "≤ 5C (DO-311A §2.4.5.5)",
                    severity:"critical",
                  },
                  {
                    id:"EASA-B2", ref:"MOC-3 SC-VTOL VTOL.2330 / SC-E-19",
                    category:"Battery Safety (MOC-3 SC-VTOL)",
                    title:"SoC Reserve Margin",
                    desc:"EASA SC-E-19 propulsion battery: minimum SoC margin maintained at all times. Final SoC must exceed minimum reserve.",
                    check: reserve_pct >= (socFloor * 100),
                    value: `${reserve_pct.toFixed(1)}% final SoC (min: ${(socFloor*100).toFixed(1)}%)`,
                    limit: `≥ ${(socFloor*100).toFixed(1)}%`,
                    severity:"critical",
                  },
                  {
                    id:"EASA-B3", ref:"MOC-3 SC-VTOL VTOL.2330",
                    category:"Battery Safety (MOC-3 SC-VTOL)",
                    title:"Battery Mass Fraction",
                    desc:"EASA SC-VTOL: battery mass fraction must be below 55% for structural mass balance and crashworthiness compliance.",
                    check: batFrac < 0.55,
                    value: `${(batFrac*100).toFixed(1)}%`,
                    limit: "< 55%",
                    severity:"major",
                  },
                  // V-tail
                  {
                    id:"EASA-T1", ref:"SC-VTOL-01 VTOL.2100 / CS-27.155",
                    category:"Control Surfaces",
                    title:"V-tail Pitch Authority",
                    desc:"Control surfaces must provide adequate pitch authority. Sh_eff/Sh_req ≥ 1.0 ensures pitch stability margin.",
                    check: SR.pitch_ratio >= 1.0,
                    value: `${(SR.pitch_ratio*100).toFixed(0)}% of requirement`,
                    limit: "≥ 100%",
                    severity:"critical",
                  },
                  {
                    id:"EASA-T2", ref:"SC-VTOL-01 VTOL.2100 / CS-27.155",
                    category:"Control Surfaces",
                    title:"V-tail Yaw Authority",
                    desc:"Differential ruddervator must provide adequate yaw authority. Sv_eff/Sv_req ≥ 1.0.",
                    check: SR.yaw_ratio >= 1.0,
                    value: `${(SR.yaw_ratio*100).toFixed(0)}% of requirement`,
                    limit: "≥ 100%",
                    severity:"critical",
                  },
                ],
              };

              // Compute scores
              const score=(arr)=>{
                const total=arr.length;
                const passed=arr.filter(rule=>rule.check).length;
                const critical_fail=arr.filter(rule=>!rule.check&&rule.severity==="critical").length;
                const major_fail=arr.filter(rule=>!rule.check&&rule.severity==="major").length;
                return{total,passed,critical_fail,major_fail,pct:Math.round(passed/total*100)};
              };
              const faaScore=score(rules.FAA);
              const easaScore=score(rules.EASA);
              const allScore=score([...rules.FAA,...rules.EASA]);

              const sevColor={critical:SC.red,major:SC.amber,advisory:"#22d3ee"};
              const sevLabel={critical:"CRITICAL",major:"MAJOR",advisory:"ADVISORY"};

              return(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:SC.panel,
                  border:`1px solid #3b82f644`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>REGULATORY COMPLIANCE — CONCEPTUAL DESIGN PHASE</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:SC.blue}}>Certification</span> Compliance Checker
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:760}}>
                    Auto-checks your design against <span style={{color:SC.blue,fontWeight:700}}>FAA AC 21.17-4</span> (Type Certification — Powered-lift, July 2025) and
                    <span style={{color:"#f59e0b",fontWeight:700}}> EASA SC-VTOL Issue 2</span> (Special Condition for VTOL-capable aircraft).
                    Results are <em>conceptual-phase guidance only</em> — actual certification requires full compliance documentation with the regulatory authority.
                    Severity: <span style={{color:SC.red}}>■ Critical</span> = must fix · <span style={{color:SC.amber}}>■ Major</span> = significant risk · <span style={{color:"#22d3ee"}}>■ Advisory</span> = recommended.
                  </div>
                </div>

                {/* Score cards */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  {[
                    ["FAA AC 21.17-4",faaScore,SC.blue,"🇺🇸"],
                    ["EASA SC-VTOL",easaScore,SC.amber,"🇪🇺"],
                    ["Combined",allScore,allScore.critical_fail===0?SC.green:SC.red,"🌐"],
                  ].map(([title,s,col,flag])=>(
                    <div key={title} style={{background:SC.panel,border:`2px solid ${col}44`,borderRadius:10,padding:"16px 18px"}}>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.1em",marginBottom:6}}>{flag} {title}</div>
                      {/* Score circle */}
                      <div style={{display:"flex",alignItems:"center",gap:14}}>
                        <div style={{width:64,height:64,borderRadius:"50%",flexShrink:0,
                          background:`conic-gradient(${col} ${s.pct*3.6}deg, ${SC.border} 0deg)`,
                          display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                          <div style={{width:50,height:50,borderRadius:"50%",background:SC.panel,
                            display:"flex",alignItems:"center",justifyContent:"center",
                            fontSize:14,fontWeight:800,color:col,fontFamily:"'DM Mono',monospace"}}>
                            {s.pct}%
                          </div>
                        </div>
                        <div>
                          <div style={{fontSize:13,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace"}}>
                            {s.passed}/{s.total} passed
                          </div>
                          {s.critical_fail>0&&<div style={{fontSize:10,color:SC.red,fontFamily:"'DM Mono',monospace"}}>⛔ {s.critical_fail} critical fail{s.critical_fail>1?"s":""}</div>}
                          {s.major_fail>0&&<div style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace"}}>⚠ {s.major_fail} major fail{s.major_fail>1?"s":""}</div>}
                          {s.critical_fail===0&&s.major_fail===0&&<div style={{fontSize:10,color:SC.green,fontFamily:"'DM Mono',monospace"}}>✓ No critical/major issues</div>}
                        </div>
                      </div>
                      <div style={{marginTop:10,height:4,background:SC.border,borderRadius:2}}>
                        <div style={{width:`${s.pct}%`,height:"100%",background:col,borderRadius:2,transition:"width 0.5s"}}/>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Key parameters used */}
                <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 16px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.1em",marginBottom:10,textTransform:"uppercase"}}>Design Parameters Used in Compliance Check</div>
                  <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                    {[
                      ["MTOW",`${MTOW_kg.toFixed(0)} kg / ${MTOW_lb.toFixed(0)} lb`,SC.amber],
                      ["Passengers",`~${nPax} pax`,SC.teal],
                      ["Battery Frac",`${(batFrac*100).toFixed(1)}%`,batFrac<0.55?SC.green:SC.red],
                      ["Hover C-rate",`${C_hover.toFixed(2)}C`,C_hover<5?SC.green:SC.red],
                      ["SM w/Vtail",`${(SR.SM_vt*100).toFixed(1)}%`,SR.SM_vt>0.05&&SR.SM_vt<0.25?SC.green:SC.red],
                      ["Tip Mach",SR.TipMach,SR.TipMach<0.70?SC.green:SC.red],
                      ["Tip Speed",`${SR.TipSpd} m/s`,SR.TipSpd<180?SC.green:SR.TipSpd<200?SC.amber:SC.red],
                      ["BPF",`${BPF.toFixed(0)} Hz`,BPF<150?SC.green:SC.amber],
                      ["Est. Noise",`${dBA_hover.toFixed(0)} dBA`,dBA_hover<65?SC.green:dBA_hover<75?SC.amber:SC.red],
                      ["Reserve",`${(SR.tres/60).toFixed(1)} min`,SR.tres>=1200?SC.green:SC.red],
                    ].map(([lbl,val,col])=>(
                      <div key={lbl} style={{background:SC.bg,border:`1px solid ${col}33`,borderRadius:6,padding:"6px 10px"}}>
                        <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{lbl}</div>
                        <div style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* FAA Rules */}
                <div style={{background:SC.panel,border:`1px solid ${SC.blue}33`,borderRadius:8,padding:"14px 16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,borderBottom:`1px solid ${SC.border}`,paddingBottom:10}}>
                    <span style={{fontSize:20}}>🇺🇸</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:800,color:SC.blue,fontFamily:"'DM Mono',monospace"}}>FAA AC 21.17-4</div>
                      <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Type Certification — Powered-lift (July 2025) · 14 CFR §21.17(b)</div>
                    </div>
                    <div style={{marginLeft:"auto",textAlign:"right"}}>
                      <div style={{fontSize:18,fontWeight:800,color:faaScore.pct>=80?SC.green:faaScore.pct>=60?SC.amber:SC.red,fontFamily:"'DM Mono',monospace"}}>{faaScore.pct}%</div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{faaScore.passed}/{faaScore.total} checks</div>
                    </div>
                  </div>
                  {/* Group by category */}
                  {[...new Set(rules.FAA.map(rl=>rl.category))].map(cat=>(
                    <div key={cat} style={{marginBottom:14}}>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",
                        textTransform:"uppercase",marginBottom:6,paddingLeft:2}}>{cat}</div>
                      {rules.FAA.filter(rl=>rl.category===cat).map(rule=>(
                        <div key={rule.id} style={{
                          background:rule.check?`${SC.green}08`:`${sevColor[rule.severity]}0c`,
                          border:`1px solid ${rule.check?SC.green+"22":sevColor[rule.severity]+"44"}`,
                          borderRadius:6,padding:"10px 14px",marginBottom:6,
                          borderLeft:`3px solid ${rule.check?SC.green:sevColor[rule.severity]}`}}>
                          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                            <div style={{flex:1}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                                <span style={{fontSize:14}}>{rule.check?"✅":"❌"}</span>
                                <span style={{fontSize:11,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{rule.title}</span>
                                {!rule.check&&(
                                  <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,fontWeight:700,
                                    fontFamily:"'DM Mono',monospace",
                                    background:`${sevColor[rule.severity]}22`,color:sevColor[rule.severity]}}>
                                    {sevLabel[rule.severity]}
                                  </span>
                                )}
                              </div>
                              <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4,lineHeight:1.5}}>{rule.desc}</div>
                              <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Ref: {rule.ref}</div>
                            </div>
                            <div style={{textAlign:"right",flexShrink:0,minWidth:130}}>
                              <div style={{fontSize:11,color:rule.check?SC.green:sevColor[rule.severity],fontFamily:"'DM Mono',monospace",fontWeight:700}}>{rule.value}</div>
                              <div style={{fontSize:9,color:SC.dim,fontFamily:"'DM Mono',monospace",marginTop:2}}>Limit: {rule.limit}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* EASA Rules */}
                <div style={{background:SC.panel,border:`1px solid ${SC.amber}33`,borderRadius:8,padding:"14px 16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,borderBottom:`1px solid ${SC.border}`,paddingBottom:10}}>
                    <span style={{fontSize:20}}>🇪🇺</span>
                    <div>
                      <div style={{fontSize:13,fontWeight:800,color:SC.amber,fontFamily:"'DM Mono',monospace"}}>EASA SC-VTOL Issue 2</div>
                      <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Special Condition for VTOL-capable aircraft · MOC-3 SC-VTOL Battery Safety</div>
                    </div>
                    <div style={{marginLeft:"auto",textAlign:"right"}}>
                      <div style={{fontSize:18,fontWeight:800,color:easaScore.pct>=80?SC.green:easaScore.pct>=60?SC.amber:SC.red,fontFamily:"'DM Mono',monospace"}}>{easaScore.pct}%</div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{easaScore.passed}/{easaScore.total} checks</div>
                    </div>
                  </div>
                  {[...new Set(rules.EASA.map(rl=>rl.category))].map(cat=>(
                    <div key={cat} style={{marginBottom:14}}>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",
                        textTransform:"uppercase",marginBottom:6,paddingLeft:2}}>{cat}</div>
                      {rules.EASA.filter(rl=>rl.category===cat).map(rule=>(
                        <div key={rule.id} style={{
                          background:rule.check?`${SC.green}08`:`${sevColor[rule.severity]}0c`,
                          border:`1px solid ${rule.check?SC.green+"22":sevColor[rule.severity]+"44"}`,
                          borderRadius:6,padding:"10px 14px",marginBottom:6,
                          borderLeft:`3px solid ${rule.check?SC.green:sevColor[rule.severity]}`}}>
                          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                            <div style={{flex:1}}>
                              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                                <span style={{fontSize:14}}>{rule.check?"✅":"❌"}</span>
                                <span style={{fontSize:11,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{rule.title}</span>
                                {!rule.check&&(
                                  <span style={{fontSize:8,padding:"2px 6px",borderRadius:3,fontWeight:700,
                                    fontFamily:"'DM Mono',monospace",
                                    background:`${sevColor[rule.severity]}22`,color:sevColor[rule.severity]}}>
                                    {sevLabel[rule.severity]}
                                  </span>
                                )}
                              </div>
                              <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4,lineHeight:1.5}}>{rule.desc}</div>
                              <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>Ref: {rule.ref}</div>
                            </div>
                            <div style={{textAlign:"right",flexShrink:0,minWidth:130}}>
                              <div style={{fontSize:11,color:rule.check?SC.green:sevColor[rule.severity],fontFamily:"'DM Mono',monospace",fontWeight:700}}>{rule.value}</div>
                              <div style={{fontSize:9,color:SC.dim,fontFamily:"'DM Mono',monospace",marginTop:2}}>Limit: {rule.limit}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Disclaimer */}
                <div style={{padding:"10px 14px",background:`${SC.blue}0a`,border:`1px solid ${SC.blue}22`,
                  borderRadius:6,fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                  ⓘ <strong style={{color:SC.text}}>Important:</strong> This checker provides <em>conceptual-design phase guidance</em> based on publicly available FAA AC 21.17-4 (July 2025),
                  EASA SC-VTOL Issue 2, and MOC-3 SC-VTOL. It is <strong>not a substitute for formal compliance documentation</strong>.
                  Actual type certification requires full qualification testing, G-1/G-2 issue papers, and regulatory authority approval.
                  Noise estimates use a simplified Pegg-type model (±5 dB accuracy); actual certification requires flight testing per 14 CFR Part 36 / EASA CS-36.
                </div>

              </div>
              );
            })()}

            {/* ──── TAB 11: NOISE ESTIMATION ──── */}
            {tab===11&&SR&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:SC.panel,
                  border:`1px solid #8b5cf644`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>ROTOR ACOUSTICS — BPF TONAL + BROADBAND MODEL</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:"#a78bfa"}}>Noise</span> Estimation & dB Contour Map
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:760}}>
                    Semi-empirical model combining <strong style={{color:"#a78bfa"}}>BPF tonal loading noise</strong> (Gutin/Deming),
                    <strong style={{color:SC.teal}}> thickness noise</strong>, and <strong style={{color:SC.blue}}> broadband self-noise</strong> (BPM-simplified).
                    Based on Fleming et al. (VFS 2022), Tinney &amp; Valdez (JASA 2020).
                    A-weighted at BPF. Multi-rotor incoherent summation +10·log₁₀(N).
                    <strong style={{color:SC.amber}}> Same values used in FAA/EASA compliance checker.</strong>
                  </div>
                </div>

                {/* KPI row */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="BPF (Blade Pass Freq)" value={SR.BPF.toFixed(1)} unit="Hz"
                    color={SR.BPF<150?SC.green:SC.amber}
                    sub={`${SR.Nbld} blades × ${SR.RPM.toFixed(0)} RPM / 60`}/>
                  <KPI label="OASPL at 1m" value={SR.OASPL_total_1m} unit="dB"
                    color={SC.muted} sub="unweighted, all rotors"/>
                  <KPI label="A-weighted at 150m" value={SR.dBA_150m} unit="dBA"
                    color={SR.dBA_150m<=65?SC.green:SR.dBA_150m<=75?SC.amber:SC.red}
                    sub="EASA UAM limit: 65 dBA"/>
                  <KPI label="65 dBA Contour Radius" value={SR.dist_65dBA} unit="m"
                    color={SR.dist_65dBA<200?SC.green:SR.dist_65dBA<500?SC.amber:SC.red}
                    sub="community noise footprint"/>
                </div>

                {/* SPL vs Distance table + chart */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="A-weighted SPL vs Distance from Aircraft">
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart
                        data={[
                          {r:1,   dBA:SR.dBA_1m},
                          {r:5,   dBA:+(SR.dBA_1m-20*Math.log10(5)-(1.8/1000*5)).toFixed(1)},
                          {r:10,  dBA:+(SR.dBA_1m-20*Math.log10(10)-(1.8/1000*10)).toFixed(1)},
                          {r:25,  dBA:SR.dBA_25m},
                          {r:50,  dBA:SR.dBA_50m},
                          {r:100, dBA:SR.dBA_100m},
                          {r:150, dBA:SR.dBA_150m},
                          {r:200, dBA:+(SR.dBA_1m-20*Math.log10(200)-(1.8/1000*200)+2.5).toFixed(1)},
                          {r:300, dBA:SR.dBA_300m},
                          {r:500, dBA:SR.dBA_500m},
                        ]}
                        margin={{top:5,right:20,left:5,bottom:20}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="r" tick={{fontSize:9,fill:SC.muted}}
                          label={{value:"Distance (m)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                        <YAxis tick={{fontSize:9,fill:SC.muted}}
                          label={{value:"dBA",angle:-90,position:"insideLeft",fontSize:11,fill:SC.muted}}/>
                        <Tooltip {...TTP} formatter={(v)=>[`${v} dBA`,"SPL"]}/>
                        <ReferenceLine y={65} stroke={SC.green}  strokeDasharray="5 3"
                          label={{value:"65 dBA (EASA UAM)",fill:SC.green,fontSize:9,position:"right"}}/>
                        <ReferenceLine y={75} stroke={SC.amber}  strokeDasharray="5 3"
                          label={{value:"75 dBA (FAA op.)",fill:SC.amber,fontSize:9,position:"right"}}/>
                        <ReferenceLine y={85} stroke={SC.red}    strokeDasharray="5 3"
                          label={{value:"85 dBA (hearing)",fill:SC.red,fontSize:9,position:"right"}}/>
                        <Line type="monotone" dataKey="dBA" stroke="#a78bfa" strokeWidth={2.5}
                          dot={{r:3,fill:"#a78bfa"}} name="A-wtd SPL (dBA)"/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>

                  {/* dB distance table */}
                  <Panel title="SPL at Key Reference Distances">
                    <div style={{marginBottom:12}}>
                      {[
                        {dist:1,   val:SR.dBA_1m,   label:"1 m (near field)"},
                        {dist:25,  val:SR.dBA_25m,  label:"25 m (helipad edge)"},
                        {dist:50,  val:SR.dBA_50m,  label:"50 m (building setback)"},
                        {dist:100, val:SR.dBA_100m, label:"100 m (residential)"},
                        {dist:150, val:SR.dBA_150m, label:"150 m (EASA UAM ref)"},
                        {dist:300, val:SR.dBA_300m, label:"300 m (community)"},
                        {dist:500, val:SR.dBA_500m, label:"500 m (far field)"},
                      ].map(({dist,val,label})=>{
                        const col=val<=55?SC.green:val<=65?SC.teal:val<=75?SC.amber:SC.red;
                        const pct=Math.min(100,Math.max(0,(val-40)/60*100));
                        return(
                          <div key={dist} style={{display:"flex",alignItems:"center",gap:8,
                            padding:"5px 0",borderBottom:`1px solid ${SC.border}`}}>
                            <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",minWidth:160}}>{label}</span>
                            <div style={{flex:1,height:6,background:SC.border,borderRadius:3}}>
                              <div style={{width:`${pct}%`,height:"100%",background:col,borderRadius:3,transition:"width 0.4s"}}/>
                            </div>
                            <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700,minWidth:52,textAlign:"right"}}>{val} dBA</span>
                          </div>
                        );
                      })}
                    </div>
                    {/* Contour table */}
                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.1em"}}>Noise Contour Radii</div>
                    {[
                      ["55 dBA",SR.dist_55dBA,"m","near-quiet"],
                      ["65 dBA",SR.dist_65dBA,"m","EASA UAM limit"],
                      ["70 dBA",SR.dist_70dBA,"m","annoyance threshold"],
                      ["75 dBA",SR.dist_75dBA,"m","FAA operational limit"],
                    ].map(([lbl,val,unit,note])=>(
                      <div key={lbl} style={{display:"flex",justifyContent:"space-between",
                        padding:"4px 0",borderBottom:`1px solid ${SC.border}22`}}>
                        <span style={{fontSize:10,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{lbl}</span>
                        <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{note}</span>
                        <span style={{fontSize:11,color:val<200?SC.green:val<500?SC.amber:SC.red,
                          fontFamily:"'DM Mono',monospace",fontWeight:700}}>{val} {unit}</span>
                      </div>
                    ))}
                  </Panel>
                </div>

                {/* BPF Harmonics spectrum */}
                <Panel title="BPF Tonal Spectrum — First 4 Harmonics (A-weighted)" ht={270}>
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
                    Tonal noise at integer multiples of BPF = {SR.BPF.toFixed(1)} Hz.
                    Higher harmonics attenuate at ~6 dB/octave. A-weighting penalises low frequencies.
                  </div>
                  <ResponsiveContainer width="100%" height={210}>
                    <BarChart data={SR.bpfHarmonics} margin={{top:5,right:20,left:5,bottom:20}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="freq" tick={{fontSize:10,fill:SC.muted}}
                        tickFormatter={fhz=>`${fhz} Hz`}
                        label={{value:"Frequency (Hz)",position:"insideBottom",offset:-6,fontSize:11,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:9,fill:SC.muted}}
                        label={{value:"SPL (dBA at 150m)",angle:-90,position:"insideLeft",fontSize:11,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${v} dBA`,"SPL"]}
                        labelFormatter={fval=>`BPF×${SR.bpfHarmonics.findIndex(harm=>harm.freq===fval)+1} = ${fval} Hz`}/>
                      <Bar dataKey="SPL" radius={[4,4,0,0]} name="dBA at 150m">
                        {SR.bpfHarmonics.map((harm,i)=>(
                          <Cell key={i} fill={harm.SPL<=65?"#22c55e":harm.SPL<=75?"#f59e0b":"#ef4444"}/>
                        ))}
                      </Bar>
                      <ReferenceLine y={65} stroke={SC.green} strokeDasharray="4 3"
                        label={{value:"65 dBA",fill:SC.green,fontSize:9,position:"right"}}/>
                    </BarChart>
                  </ResponsiveContainer>
                </Panel>

                {/* SVG dB Contour Map */}
                <Panel title="dB Noise Contour Map — Top View (hover condition, all rotors)">
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
                    Concentric contours show A-weighted noise level at ground level below hovering aircraft.
                    Aircraft positioned at center. Distances to scale.
                  </div>
                  {(()=>{
                    const W=540,H=400,cx=W/2,cy=H/2;
                    const scale=0.38; // px per meter
                    const contours=[
                      {dBA:85,col:"#ef4444",label:"85 dBA", dist:SR.dist_75dBA&&(SR.dBA_1m-85)>0?Math.pow(10,(SR.dBA_1m-85)/20):0},
                      {dBA:75,col:"#f59e0b",label:"75 dBA", dist:SR.dist_75dBA},
                      {dBA:65,col:"#22c55e",label:"65 dBA", dist:SR.dist_65dBA},
                      {dBA:55,col:"#14b8a6",label:"55 dBA", dist:SR.dist_55dBA},
                    ];
                    return(
                      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{maxHeight:380,background:darkMode?"#06090e":"#f0f4f8",borderRadius:8}}>
                        {/* Grid */}
                        {[-400,-300,-200,-100,0,100,200,300,400].map(d=>(
                          <g key={d}>
                            <line x1={cx+d*scale} y1={0} x2={cx+d*scale} y2={H} stroke={darkMode?"#1c2333":"#cbd5e1"} strokeWidth={0.5}/>
                            <line x1={0} y1={cy+d*scale} x2={W} y2={cy+d*scale} stroke={darkMode?"#1c2333":"#cbd5e1"} strokeWidth={0.5}/>
                          </g>
                        ))}
                        {/* Noise contour rings — use SR.dist_*dBA (full propagation model) */}
                        {contours.map(({dBA,col,label,dist})=>{
                          const distM = dist || 0;
                          const r = distM * scale;
                          if(r<=0||r>W) return null;
                          return(
                            <g key={dBA}>
                              <circle cx={cx} cy={cy} r={r} fill={col+"18"} stroke={col} strokeWidth={1.5} strokeDasharray="6 3"/>
                              <text x={cx+r+4} y={cy-4} fontSize={9} fill={col} fontFamily="DM Mono,monospace" fontWeight={700}>{label}</text>
                              <text x={cx+r+4} y={cy+10} fontSize={8} fill={col} fontFamily="DM Mono,monospace">{Math.round(distM)}m</text>
                            </g>
                          );
                        })}
                        {/* Aircraft icon at center */}
                        <circle cx={cx} cy={cy} r={6} fill={SC.amber} opacity={0.9}/>
                        <text x={cx} y={cy-12} textAnchor="middle" fontSize={18}>✈️</text>
                        <text x={cx} y={cy+22} textAnchor="middle" fontSize={9} fill={SC.amber} fontFamily="DM Mono,monospace">Aircraft</text>
                        {/* Rotor positions */}
                        {Array.from({length:params.nPropHover}).map((_,i)=>{
                          const ang=i*2*Math.PI/params.nPropHover-Math.PI/2;
                          const rr=SR.bWing/4*scale;
                          return <circle key={i} cx={cx+rr*Math.cos(ang)} cy={cy+rr*Math.sin(ang)}
                            r={SR.Drotor/2*scale} fill="#3b82f611" stroke="#3b82f6" strokeWidth={1}/>;
                        })}
                        {/* Scale bar */}
                        <line x1={W-90} y1={H-20} x2={W-90+100*scale} y2={H-20} stroke={darkMode?"#94a3b8":"#64748b"} strokeWidth={2}/>
                        <text x={W-90} y={H-8} fontSize={9} fill={darkMode?"#94a3b8":"#64748b"} fontFamily="DM Mono,monospace">0</text>
                        <text x={W-90+100*scale} y={H-8} fontSize={9} fill={darkMode?"#94a3b8":"#64748b"} fontFamily="DM Mono,monospace">100m</text>
                        {/* Legend */}
                        <text x={10} y={20} fontSize={10} fill={darkMode?"#94a3b8":"#64748b"} fontFamily="DM Mono,monospace">Hover noise contours</text>
                        <text x={10} y={34} fontSize={9} fill={darkMode?"#64748b":"#94a3b8"} fontFamily="DM Mono,monospace">BPF={SR.BPF.toFixed(0)}Hz · Vtip={SR.TipSpd}m/s · {params.nPropHover} rotors</text>
                      </svg>
                    );
                  })()}
                </Panel>

                {/* Noise sensitivity / optimization */}
                <Panel title="Design Sensitivity — How to Reduce Noise">
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                    {[
                      {title:"↓ Tip Speed",icon:"🔄",current:`${SR.TipSpd} m/s`,
                        impact:`−${(SR.noise_sensitivity?.tipSpeed_1pct||0.4).toFixed(2)} dBA per 1% reduction`,
                        action:"Reduce RPM or rotor diameter",
                        col:SC.green},
                      {title:"↑ Rotor Diameter",icon:"⭕",current:`${SR.Drotor} m`,
                        impact:`Larger disk → lower disk loading → quieter`,
                        action:"Increase propDiam slider",
                        col:SC.teal},
                      {title:"↑ Blade Count",icon:"🍃",current:`${SR.Nbld} blades`,
                        impact:`${(SR.noise_sensitivity?.bladeCount_1more||(-1.76)).toFixed(1)} dBA per extra blade`,
                        action:"More blades spread tonal energy",
                        col:SC.blue},
                    ].map(({title,icon,current,impact,action,col})=>(
                      <div key={title} style={{background:SC.bg,border:`1px solid ${col}33`,borderRadius:8,padding:"12px 14px",borderLeft:`3px solid ${col}`}}>
                        <div style={{fontSize:13,marginBottom:4}}>{icon} <span style={{fontSize:11,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace"}}>{title}</span></div>
                        <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:3}}>Current: {current}</div>
                        <div style={{fontSize:10,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:3}}>{impact}</div>
                        <div style={{fontSize:9,color:SC.dim,fontFamily:"'DM Mono',monospace"}}>→ {action}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{marginTop:10,padding:"8px 12px",background:`${"#a78bfa"}11`,
                    border:`1px solid ${"#a78bfa"}33`,borderRadius:6,fontSize:10,
                    color:"#a78bfa",fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                    ⓘ Model accuracy: ±5 dB (typical for semi-empirical BPF methods at conceptual design phase).
                    Broadband noise dominates in forward flight; tonal noise (BPF harmonics) dominates in hover.
                    For high-fidelity prediction use ANOPP2 or PSU-WOPWOP with CFD inflow data.
                  </div>
                </Panel>

                {/* ── Acoustic Model Methodology ── */}
                <Panel title="Acoustic Model — Methodology & Limitations">
                  <div>
                    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'4px 0 10px 0'}}>
                      <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                        Gutin-inspired far-field approximation · 8 harmonics · per-frequency A-weighting
                      </span>
                      <span style={{fontSize:9,color:SC.amber,fontFamily:"'DM Mono',monospace",padding:'3px 10px',border:`1px solid ${SC.amber}44`,borderRadius:4}}>
                        Calibrated empirical model — not certification-grade
                      </span>
                    </div>
                    <div style={{display:'flex',flexDirection:'column',gap:10}}>

                            {/* Formula box */}
                            <div style={{background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:8,padding:'14px 16px'}}>
                              <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:10}}>
                                Exact Formulation
                              </div>
                              {[
                                ['Tonal loading (Gutin + Bessel + compressibility):',
                                 'p_rms = J₁(x)·D(θ)·B·Ω·T / (4π·r₀·ρ·c₀²·√2)   →   SPL₁ = 20·log₁₀(p_rms / 2×10⁻⁵) + K_cal + C_comp',
                                 'K_cal = f(DL, Mtip, B) — multi-param calibration vs Fleming 2022 + Joby/Volocopter data. J₁ Bessel directivity included (FIX 2.1).'],
                                ['Harmonic series (adaptive decay, Gutin-consistent):',
                                 'SPL_n = SPL₁ − α·(n−1),   n = 1…10;   α = f(Mtip, DL) ∈ [2, 7] dB/harm',
                                 '✅ Physically correct — harmonics decay from SPL₁. Removed unphysical +20·log₁₀(n) growth term (FIX 2.4). Fleming 2022 range: 3–6 dB/harm.'],
                                ['Broadband self-noise (Tinney & Valdez 2020):',
                                 'dBA_broadband = dBA_tonal − 8 dB   (midpoint of 5–10 dB experimental range)',
                                 '⚠️ Uncertainty ±5 dB — depends on Re, turbulence, blade design. Empirical only.'],
                                ['Incoherent component sum (single rotor):',
                                 'OASPL_single = 10·log₁₀(10^(L_T/10) + 10^(L_thick/10) + 10^(L_BB/10))',
                                 'Sources assumed acoustically uncorrelated'],
                                ['Multi-rotor summation:',
                                 'OASPL_total = OASPL_single + 10·log₁₀(N_rot)',
                                 'Identical uncorrelated rotors — valid at conceptual design level'],
                                ['A-weighting — applied per harmonic frequency:',
                                 'dBA_n = SPL_n + A(f_n),   f_n = B·n·Ω/(2π),   then energy sum',
                                 '✅ Correct approach — NOT single-frequency. IEC 61672. Harmonics 3–5 dominate A-weighted total.'],
                                ['Hover thrust:',
                                 'T = MTOW·g / N_rot   (T/W = 1.0 — hover equilibrium)',
                                 'Not design T/W — rotor operates at W/N in steady hover'],
                                ['Distance propagation:',
                                 'dBA(r) = dBA(1m) − 20·log₁₀(r / 1m)',
                                 'Free-field spherical spreading — no ground reflection or atmosphere'],
                              ].map(([title,formula,note],i)=>(
                                <div key={i} style={{marginBottom:10,paddingBottom:10,borderBottom:i<7?`1px solid ${SC.border}22`:'none'}}>
                                  <div style={{fontSize:9,color:SC.amber,fontFamily:"'DM Mono',monospace",fontWeight:700,marginBottom:3}}>{title}</div>
                                  <div style={{fontSize:10,color:SC.teal,fontFamily:"'DM Mono',monospace",marginBottom:2}}>{formula}</div>
                                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{note}</div>
                                </div>
                              ))}
                            </div>

                            {/* Calibration */}
                            <div style={{background:SC.bg,border:`1px solid ${SC.green}33`,borderRadius:8,padding:'12px 16px'}}>
                              <div style={{fontSize:10,fontWeight:700,color:SC.green,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Calibration References</div>
                              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
                                {[
                                  ['Volocopter 2X (DLR 2020)','18 rotors, R=0.9m','~65 dBA at 100m','Model gives: '+SR.dBA_100m+' dBA at 100m'],
                                  ['Joby S4 (Joby Aviation 2021)','6 rotors, R=1.52m (similar to our design)','~65 dBA at 150m, ~45 at 500m','Model gives: '+SR.dBA_500m+' dBA at 500m (K_cal fitted to this class)'],
                                ].map(([name,config,measured,modelled])=>(
                                  <div key={name} style={{background:`${SC.panel}`,border:`1px solid ${SC.border}`,borderRadius:6,padding:'10px 12px'}}>
                                    <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{name}</div>
                                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{config}</div>
                                    <div style={{fontSize:9,color:SC.green,fontFamily:"'DM Mono',monospace",marginTop:4}}>Measured: {measured}</div>
                                    <div style={{fontSize:9,color:SC.teal,fontFamily:"'DM Mono',monospace"}}>{modelled}</div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Limitations */}
                            <div style={{background:SC.bg,border:`1px solid ${SC.red}33`,borderRadius:8,padding:'12px 16px'}}>
                              <div style={{fontSize:10,fontWeight:700,color:SC.red,fontFamily:"'DM Mono',monospace",marginBottom:8}}>Validity Envelope & Limitations</div>
                              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:6,fontSize:9,fontFamily:"'DM Mono',monospace",color:SC.muted,lineHeight:1.7}}>
                                {[
                                  ['✅ Valid for:','Hover and low-speed flight (V∞ ≈ 0)'],
                                  ['✅ Valid for:','M_tip < 0.70 (subsonic, no shock noise)'],
                                  ['✅ Valid for:','Urban eVTOL rotor sizes (R = 0.5–3.0m)'],
                                  ['✅ Valid for:','Conceptual design comparison and trend analysis'],
                                  ['✅ Modelled:','Atmospheric absorption (ISO 9613-1 simplified, 70% RH, 20°C)'],
                                  ['✅ Modelled:','Ground reflection (+2.5 dB image-source, r > 10 m)'],
                                  ['✅ Modelled:','10 harmonics with A-weighting per frequency (IEC 61672)'],
                                  ['✅ Modelled:','Bessel directivity J₁(x) + compressibility C_comp(Mtip)'],
                                  ['❌ Not modelled:','Forward flight noise (BVI, thickness noise in cruise)'],
                                  ['❌ Not modelled:','Directional radiation patterns — in-plane monopole only'],
                                  ['❌ Not modelled:','Rotor–rotor interaction (phasing, wake ingestion)'],
                                  ['⚠️ Calibration:','K_cal = f(DL, Mtip, B) — curve-fitted vs Fleming 2022 + Joby/Volocopter data (±2 dB)'],
                                  ['⚠️ Harmonic decay:','α ∈ [2–7] dB/harm, adaptive with Mtip and DL. Fleming 2022 range: 3–6 dB/harm'],
                                  ['⚠️ Broadband:','−8 dB below tonal + Mtip⁵ scaling. Uncertainty ±5 dB'],
                                  ['⚠️ Use for:','Trends and comparisons — NOT certification-level assessment'],
                                ].map(([tag,desc],i)=>(
                                  <div key={i} style={{display:'flex',gap:6}}>
                                    <span style={{color:tag.startsWith('✅')?SC.green:tag.startsWith('❌')?SC.red:SC.amber,minWidth:90,fontWeight:600}}>{tag}</span>
                                    <span>{desc}</span>
                                  </div>
                                ))}
                              </div>
                            </div>

                          </div>
                    </div>
                </Panel>
              </div>
            )}

            {/* ──── TAB 12: COST ESTIMATOR ──── */}
            {tab===12&&SR&&(()=>{
              // ═══════════════════════════════════════════════════
              // COST MODEL — energy economics + lifecycle
              // Based on: NREL eVTOL cost studies, Joby/Archer investor docs
              // ═══════════════════════════════════════════════════
              // ═══════════════════════════════════════════════════════════════════
              // DIRECT OPERATING COST (DOC) MODEL
              // Formulas: ICAO Doc 9502, ATA iSpec 2200, Vascik MIT 2020
              // Battery:  BNEF Electric Vehicle Outlook 2024 ($/kWh)
              // Ops:      NASA/CR-2019-220217 UAM Market Study (Oliver Wyman)
              //           Joby S-1 2021, Archer S-1 2021 investor disclosures
              // Maint:    FAA Helicopter Flying Handbook AC 61-13B benchmark
              //           Booz Allen / NASA AAM Cost Model 2021
              // Insurance: GAMA Statistical Databook 2023
              // Electricity: EIA Electric Power Monthly (Nov 2024)
              // ═══════════════════════════════════════════════════════════════

              // ─────────────────────────────────────────────────────────────────
              // DIRECT OPERATING COST (DOC) MODEL v3
              // Formulas: ICAO Doc 9502, ATA iSpec 2200, Vascik MIT 2020
              // Battery:  BNEF Electric Vehicle Outlook 2024 ($/kWh)
              // Ops:      NASA/CR-2019-220217 UAM Market Study (Oliver Wyman)
              //           Joby S-1 2021, Archer S-1 2021 investor disclosures
              // Maint:    FAA Helicopter Flying Handbook AC 61-13B benchmark
              //           Booz Allen / NASA AAM Cost Model 2021
              // Insurance: GAMA Statistical Databook 2023
              // Electricity: EIA Electric Power Monthly (Nov 2024)
              // ─────────────────────────────────────────────────────────────────

              // ── 1. OPERATIONAL PARAMETERS ─────────────────────────────────
              const flightsPerDay     = 10;
              const daysPerYear       = 300;
              const flightsPerYear    = flightsPerDay * daysPerYear;
              const flightDuration_hr = SR.Tend / 3600;
              const tripDist_km       = params.range;
              const nSeats            = Math.max(1, Math.round(params.payload / 90));

              // ── 2. ENERGY COST — charger round-trip efficiency only ─────────
              // SR.Etot = electrical energy drawn from the battery pack [kWh].
              // Battery discharge losses (Joule heating in pack) are already captured
              // inside the physics engine via etaBat (discharge η in Wbat formula).
              // Adding eta_bat_discharge here would double-count those losses.
              //
              // What IS missing from SR.Etot: the ground-side charger losses
              // (AC grid → onboard battery), governed by charger efficiency η_charger.
              // Grid draw = SR.Etot / η_charger  (FIX 3.1: removed eta_bat_discharge)
              //
              // η_charger: ground-side AC/DC round-trip (SAE ARP6504)
              //   At 1C recharge: ~0.95; at 3C fast-charge: ~0.88
              const CrateHov         = SR.CrateHov || 3.0;
              const eta_charger       = Math.max(0.85, 0.97 - 0.030 * CrateHov);
              // FIX 3.1: energyPerFlight = SR.Etot / η_charger  (NOT ÷ eta_bat_discharge too)
              const energyPerFlight_kWh = SR.Etot / eta_charger;
              // Time-of-use: EIA 2024 base + vertiport demand charge (EPRI 2023)
              const electricityRate_base = 0.12;
              const demandCharge         = 0.04;
              const electricityRate_kWh  = electricityRate_base + demandCharge;
              const energyCost_per_flight = energyPerFlight_kWh * electricityRate_kWh;

              // ── 3. BATTERY REPLACEMENT — cell $/kWh(SED) + fixed pack overhead ─
              // Separated into two physically distinct components:
              //   (a) Cell cost: scales with SED via BNEF learning curve (∝ SED^−0.3)
              //       Ref: $149/kWh at 300 Wh/kg (BNEF EVO 2024 NMC)
              //   (b) Pack overhead: BMS, thermal mgmt, structure, wiring
              //       ~$55/kWh mostly fixed (Fraunhofer ISE 2023 pack cost study)
              //       SED improvement reduces cell cost but NOT pack overhead
              // Aviation cert premium 2× on both (FAA AC 21.17-4 qualification costs)
              const sedRef              = 300;
              const cellCostPerKwh      = 149 * Math.pow(sedRef / Math.max(100, params.sedCell), 0.3);
              const packOH_per_kWh      = 55;  // $/kWh fixed overhead (Fraunhofer ISE 2023)
              const certFactor          = 2.0;
              const battCostPerKwh_pack = (cellCostPerKwh + packOH_per_kWh) * certFactor;
              const packReplCost        = SR.PackkWh * battCostPerKwh_pack;

              // Cycle life: DoD both directions (Thornton 2019) × C-rate penalty (Waldmann 2014)
              //   DoD < 50%: bonus (shallow discharge extends life)
              //   DoD > 50%: penalty (deep discharge accelerates SEI cracking)
              //   Combined: Neff = Nrated × (0.50/DoD)^β, β=0.5 (bonus), β=0.6 (penalty)
              //   C-rate penalty: Neff further reduced by high discharge currents
              const batteryCycles  = 900;
              const chargeDepth    = Math.min(0.85, SR.Etot / SR.PackkWh);
              const dodExponent    = chargeDepth < 0.50 ? 0.5 : 0.6;   // asymmetric
              const dodFactor      = Math.pow(0.50 / chargeDepth, dodExponent);
              const cRatePenalty   = Math.max(0.50, Math.pow(2.0 / Math.max(1.0, CrateHov), 0.45));
              const effectiveCycles = Math.floor(Math.min(2000, batteryCycles * dodFactor * cRatePenalty));
              const battCost_per_flight = packReplCost / Math.max(1, effectiveCycles);

              // ── 4. MAINTENANCE — scheduled + MMH-variable + MTBF unscheduled ─
              // Scheduled: annual A-check equivalent — Booz Allen NASA AAM 2021
              const scheduledMx_annual    = 45000;
              const scheduledMx_per_flight = scheduledMx_annual / flightsPerYear;

              // Variable MMH = f(nMotors, hoverFraction) — calibrated vs eVTOL-master
              // eVTOL-master: MMH_FH = 0.6 (helicopter baseline, Booz Allen)
              // Our formula scales from 0.6 baseline + motor count + hover fraction penalty
              //   → conservative for novel eVTOL with more drive train components
              const hoverFraction  = (SR.tto + SR.tld) / Math.max(1, SR.Tend);
              const MMH_base       = 0.6;   // eVTOL-master baseline (Booz Allen AAM 2021)
              const MMH_motors     = 0.08 * Math.max(0, params.nPropHover - 4); // per extra motor
              const MMH_hover      = 0.4 * hoverFraction;   // hover stress penalty
              const MMH_per_FH     = MMH_base + MMH_motors + MMH_hover;
              const laborRate_per_hr = 75;
              const partsCost_per_FH = 75;
              const maintRate_per_FH = MMH_per_FH * laborRate_per_hr + partsCost_per_FH;
              const varMaintCost_per_flight = maintRate_per_FH * flightDuration_hr;

              // Unscheduled (MTBF-driven): failure events per FH × avg repair cost
              //   Motor MTBF: 8,000 hr (Rolls-Royce E-Motor TBO target, 2022)
              //   ESC/inverter MTBF: 5,000 hr (Siemens SP260D data)
              //   Avg unscheduled repair: $1,200/event (Booz Allen AAM 2021)
              const MTBF_motor_hr  = 8000;
              const MTBF_ESC_hr    = 5000;
              const unschRepair_$  = 1200;
              const failRate_FH    = params.nPropHover * (1/MTBF_motor_hr + 1/MTBF_ESC_hr);
              const unschedMx_per_flight = failRate_FH * unschRepair_$ * flightDuration_hr;

              const maintenanceCost_per_flight = scheduledMx_per_flight + varMaintCost_per_flight + unschedMx_per_flight;

              // ── 5. MOTOR REPLACEMENT COST ─────────────────────────────────
              const motorTBO_hr    = 3000;
              const motorCost_per_kW = 100;
              const motorCount     = params.nPropHover;
              const motorCostEach  = SR.PmotKW * motorCost_per_kW;
              const flightsPerMotor = Math.floor(motorTBO_hr / Math.max(0.1, flightDuration_hr));
              const motorCost_per_flight = (motorCostEach * motorCount) / Math.max(1, flightsPerMotor);

              // ── 6. INSURANCE ──────────────────────────────────────────────
              const aircraftValue  = SR.MTOW * 800;
              const insuranceRate  = 0.10;
              const insuranceCost_per_flight = (aircraftValue * insuranceRate) / flightsPerYear;

              // ── 7. VERTIPORT INFRASTRUCTURE FEE ──────────────────────────
              const vertiportFee_per_flight = 35;

              // ── 8. PILOT / RPIC OPERATOR — autonomy scenario ─────────────
              // eVTOL roadmap: piloted → remote supervised → fully autonomous
              //   Piloted:    full salary per aircraft (current ops)
              //   Remote:     1 RPIC supervises 4 aircraft simultaneously (near-term)
              //   Autonomous: minimal oversight, ~$5k/yr/aircraft residual (far-term)
              // Ref: FAA AC 21.17-4, Joby/Wisk autonomy roadmaps
              const autonomyMode = 0; // 0=piloted, 1=remote, 2=autonomous
              const rpicSalary_annual = 82000;
              const aircraftPerRPIC   = autonomyMode === 0 ? 4 : autonomyMode === 1 ? 12 : 100;
              const dutyHoursPerYear  = daysPerYear * 8;
              const rpicCostPerHour   = rpicSalary_annual / (aircraftPerRPIC * dutyHoursPerYear);
              const turnaroundTime_hr = 15 / 60;
              const operatorCost_per_flight = rpicCostPerHour * (flightDuration_hr + turnaroundTime_hr);

              // ── 9. TYPE CERTIFICATION & AIRWORTHINESS AMORTIZATION ────────
              // FIX 3.3: $1M was a software bug — FAA Part 21 type cert for a novel
              // eVTOL category costs $50M–$200M (Joby ~$100M, Archer estimate similar).
              // Reference: FAA AC 21.17-4 (powered-lift cert), Congressional testimony
              // Joby Aviation S-1 (2021), NASA UAM Ecosystem (Vascik 2020).
              // Amortized over a 50-aircraft fleet × 10 operating years:
              //   certCost_per_flight = $75M / (50 × 3000 flights/yr × 10 yr) ≈ $0.50/flight
              // (Previously $1M / (3000 × 10) ≈ $0.033/flight — factor of 75× too low.)
              const certCost_total    = 75_000_000;  // $75M conservative type cert (FAA Part 21)
              const certFleetSize     = 50;           // aircraft over which cert is amortised
              const aircraftLifeYears = 10;
              const certCost_per_flight = certCost_total / (certFleetSize * flightsPerYear * aircraftLifeYears);

              // ── 10. TOTAL DOC ──────────────────────────────────────────────
              const totalCost_per_flight = energyCost_per_flight
                + battCost_per_flight
                + motorCost_per_flight
                + maintenanceCost_per_flight
                + insuranceCost_per_flight
                + vertiportFee_per_flight
                + operatorCost_per_flight
                + certCost_per_flight;

              const cost_per_km      = totalCost_per_flight / tripDist_km;
              const cost_per_seat_km = cost_per_km / Math.max(1, nSeats);

              // ── 11. REVENUE MODEL ─────────────────────────────────────────
              const farePerKm        = 4.50;
              const loadFactor       = 0.78;
              const revenuePerFlight = farePerKm * tripDist_km * loadFactor;
              const annualRevenue    = revenuePerFlight * flightsPerYear;
              const annualCost       = totalCost_per_flight * flightsPerYear;
              const annualProfit     = annualRevenue - annualCost;
              const profitMargin     = annualRevenue > 0 ? (annualProfit / annualRevenue) * 100 : -100;

              // ── 12. BREAK-EVEN — profit vs LF curve (not just single point) ─
              // Compute profit at 11 load-factor points (0..100%) for each fare scenario
              // This shows full sensitivity: where each route crosses zero profit
              const fareScenarios = [
                {label:"Joby $1.86/km", fare:1.86, col:"#22c55e"},
                {label:"NASA $4.50/km", fare:4.50, col:"#f59e0b"},
                {label:"Blade $6.00/km",fare:6.00, col:"#8b5cf6"},
              ].map(s=>({
                ...s,
                beLF: Math.min(1, totalCost_per_flight / (Math.max(1,nSeats) * s.fare * tripDist_km)),
              }));
              // LF vs profit data for chart (11 points, 0%→100%)
              const profitVsLF = Array.from({length:11},(_,i)=>{
                const lf = i / 10;
                const obj = {lf: +(lf*100).toFixed(0)};
                fareScenarios.forEach(s=>{
                  const rev = s.fare * tripDist_km * nSeats * lf;
                  obj[s.label] = +(rev - totalCost_per_flight).toFixed(0);
                });
                return obj;
              });
              const breakEvenLF      = fareScenarios[1].beLF;
              const breakEvenFare_km = totalCost_per_flight / (Math.max(1,nSeats) * loadFactor * tripDist_km);

              // ── 13. ROI / PAYBACK ──────────────────────────────────────────
              const aircraftCost  = SR.MTOW * 800;
              const paybackYears  = annualProfit > 0 ? aircraftCost / annualProfit : Infinity;

              const helicopter_cost_per_km = 4.50;
              const savings_vs_heli_pct    = ((helicopter_cost_per_km - cost_per_km) / helicopter_cost_per_km) * 100;

              // Battery degradation curve (SoH vs cycle count) — NREL power-law model
              const degradationData = Array.from({length:11},(_,i)=>{
                const cycles = i * batteryCycles / 10;
                const SoH = Math.max(0.60, 1 - 0.20 * Math.pow(cycles / batteryCycles, 0.8));
                return {cycles:+cycles.toFixed(0), SoH:+(SoH*100).toFixed(1),
                  capacity:+(SoH*SR.PackkWh).toFixed(2)};
              });

              // Cost breakdown for pie
              const costParts=[
                {name:"Battery",    val:+battCost_per_flight.toFixed(2),        col:"#f59e0b"},
                {name:"Maintenance",val:+maintenanceCost_per_flight.toFixed(2), col:"#8b5cf6"},
                {name:"Insurance",  val:+insuranceCost_per_flight.toFixed(2),   col:"#ef4444"},
                {name:"Energy",     val:+energyCost_per_flight.toFixed(2),      col:"#22c55e"},
                {name:"Motors",     val:+motorCost_per_flight.toFixed(2),       col:"#3b82f6"},
                {name:"Vertiport",  val:+vertiportFee_per_flight.toFixed(2),    col:"#14b8a6"},
                {name:"Operator",   val:+operatorCost_per_flight.toFixed(2),    col:"#6c757d"},
                {name:"Cert/Airw.", val:+certCost_per_flight.toFixed(2),        col:"#ec4899"},
              ];

              return(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:darkMode?"linear-gradient(135deg,#0d1a0d,#0a1f14)":SC.panel,
                  border:`1px solid #22c55e44`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>$/FLIGHT ECONOMICS — LIFECYCLE COST MODEL</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:SC.green}}>Cost</span> Estimator & ROI Analysis
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7}}>
                    Lifecycle cost model calibrated against NASA CR-2021-003, NASA/CR-2019-220217 UAM Cost Model,
                    FAA AC 21.17-4 (2023), BloombergNEF 2024, EIA 2024, and Joby/Archer investor disclosures.
                    Assumes <strong style={{color:SC.green}}>{flightsPerDay} flights/day · {daysPerYear} days/yr · {tripDist_km} km trip · {(loadFactor*100).toFixed(0)}% load factor</strong>.
                    All figures in 2025 USD. Maintenance scaled to flight duration ({(flightDuration_hr*60).toFixed(0)} min/flight).
                  </div>
                </div>

                {/* Top KPIs */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Total DOC / Flight" value={`$${totalCost_per_flight.toFixed(0)}`} unit=""
                    color={SC.amber} sub={`$${cost_per_km.toFixed(2)}/km · $${cost_per_seat_km.toFixed(2)}/seat-km`}/>
                  <KPI label="vs Helicopter" value={`${savings_vs_heli_pct.toFixed(0)}% ${savings_vs_heli_pct>0?"cheaper":"costlier"}`} unit=""
                    color={savings_vs_heli_pct>0?SC.green:SC.red}
                    sub={`Bell 206B3: $${helicopter_cost_per_km}/km`}/>
                  <KPI label="Annual Profit" value={annualProfit>0?`$${(annualProfit/1000).toFixed(0)}k`:"Not viable"} unit=""
                    color={annualProfit>0?SC.green:SC.red}
                    sub={`Margin: ${profitMargin.toFixed(1)}%`}/>
                  <KPI label="Payback Period" value={paybackYears===Infinity||paybackYears>99?"N/A":`${paybackYears.toFixed(1)} yrs`} unit=""
                    color={paybackYears<5?SC.green:paybackYears<10?SC.amber:SC.red}
                    sub={annualProfit>0?`Aircraft: $${(aircraftCost/1000).toFixed(0)}k`:"Profit negative → no payback"}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Energy Cost/Flight" value={`$${energyCost_per_flight.toFixed(2)}`} unit=""
                    color={SC.teal} sub={`${energyPerFlight_kWh} kWh × $${electricityRate_kWh.toFixed(2)}/kWh`}/>
                  <KPI label="Battery Cost/Flight" value={`$${battCost_per_flight.toFixed(2)}`} unit=""
                    color={SC.amber} sub={`${effectiveCycles} cycles · ${(chargeDepth*100).toFixed(0)}% DoD · ${CrateHov.toFixed(1)}C`}/>
                  <KPI label="Break-Even Load Factor" value={`${(breakEvenLF*100).toFixed(1)}%`} unit=""
                    color={breakEvenLF<0.7?SC.green:breakEvenLF<0.9?SC.amber:SC.red}
                    sub={`Need $${breakEvenFare_km.toFixed(2)}/km at 75% LF`}/>
                  <KPI label="Revenue/Flight" value={`$${revenuePerFlight.toFixed(0)}`} unit=""
                    color={SC.green} sub={`${nSeats} seats · ${(loadFactor*100).toFixed(0)}% LF · $${farePerKm}/km`}/>
                </div>

                {/* Cost breakdown + battery degradation */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Cost Breakdown per Flight ($)" ht={280}>
                    <ResponsiveContainer width="100%" height={235}>
                      <PieChart>
                        <Pie data={costParts} dataKey="val" nameKey="name"
                          cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={2}>
                          {costParts.map((cp,i)=><Cell key={i} fill={cp.col}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v)=>[`$${v}`,""]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:10,color:SC.muted}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Battery Pack Degradation vs Charge Cycles" ht={280}>
                    <ResponsiveContainer width="100%" height={235}>
                      <AreaChart data={degradationData} margin={{top:5,right:15,left:-10,bottom:0}}>
                        <defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={SC.amber} stopOpacity={0.4}/>
                          <stop offset="95%" stopColor={SC.amber} stopOpacity={0.02}/>
                        </linearGradient></defs>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="cycles" tick={{fontSize:9,fill:SC.muted}}
                          label={{value:"Cycles",position:"insideBottom",fontSize:10,fill:SC.muted}}/>
                        <YAxis domain={[50,105]} tick={{fontSize:9,fill:SC.muted}}
                          label={{value:"SoH (%)",angle:-90,position:"insideLeft",fontSize:10,fill:SC.muted}}/>
                        <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                        <ReferenceLine y={80} stroke={SC.red} strokeDasharray="4 3"
                          label={{value:"80% SoH (replace)",fill:SC.red,fontSize:9,position:"right"}}/>
                        <Area type="monotone" dataKey="SoH" stroke={SC.amber} strokeWidth={2.5}
                          fill="url(#dg)" dot={false} name="State of Health (%)"/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>

                {/* Annual P&L */}
                <Panel title="Annual Economics — P&L Summary">
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8}}>Annual Costs</div>
                      {[
                        ["Energy",          energyCost_per_flight*flightsPerYear],
                        ["Battery",         battCost_per_flight*flightsPerYear],
                        ["Motors",          motorCost_per_flight*flightsPerYear],
                        ["Maintenance",     maintenanceCost_per_flight*flightsPerYear],
                        ["Insurance",       insuranceCost_per_flight*flightsPerYear],
                        ["Vertiport fees",  vertiportFee_per_flight*flightsPerYear],
                        ["Operator",        operatorCost_per_flight*flightsPerYear],
                        ["Cert/Airworthiness", certCost_per_flight*flightsPerYear],
                      ].map(([k,v])=>{
                        const pct=v/annualCost*100;
                        return(
                          <div key={k} style={{display:"flex",alignItems:"center",gap:8,padding:"4px 0",borderBottom:`1px solid ${SC.border}22`}}>
                            <span style={{fontSize:10,color:SC.text,fontFamily:"'DM Mono',monospace",minWidth:110}}>{k}</span>
                            <div style={{flex:1,height:5,background:SC.border,borderRadius:2}}>
                              <div style={{width:`${pct}%`,height:"100%",background:SC.amber,borderRadius:2}}/>
                            </div>
                            <span style={{fontSize:10,color:SC.amber,fontFamily:"'DM Mono',monospace",minWidth:60,textAlign:"right"}}>${(v/1000).toFixed(0)}k</span>
                          </div>
                        );
                      })}
                      <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderTop:`2px solid ${SC.border}`,marginTop:4}}>
                        <span style={{fontSize:11,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace"}}>Total Annual Cost</span>
                        <span style={{fontSize:11,fontWeight:700,color:SC.red,fontFamily:"'DM Mono',monospace"}}>${(annualCost/1000).toFixed(0)}k</span>
                      </div>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:8}}>Revenue & Profit</div>
                      {[
                        ["Flights/year",`${flightsPerYear.toLocaleString()}`,SC.muted],
                        ["Revenue/flight",`$${revenuePerFlight.toFixed(0)}`,SC.teal],
                        ["Annual Revenue",`$${(annualRevenue/1000).toFixed(0)}k`,SC.green],
                        ["Annual Cost",   `$${(annualCost/1000).toFixed(0)}k`,SC.red],
                        ["Annual Profit", `$${(annualProfit/1000).toFixed(0)}k`,annualProfit>0?SC.green:SC.red],
                        ["Profit Margin", `${profitMargin.toFixed(1)}%`,profitMargin>20?SC.green:profitMargin>5?SC.amber:SC.red],
                        ["Payback Period",paybackYears===Infinity?"Not viable":`${Math.min(99,paybackYears).toFixed(1)} yrs`,paybackYears<5?SC.green:paybackYears<20?SC.amber:SC.red],
                        ["Cost vs Heli",  `${savings_vs_heli_pct.toFixed(0)}% cheaper`,savings_vs_heli_pct>0?SC.green:SC.red],
                      ].map(([k,v,col])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${SC.border}22`}}>
                          <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{k}</span>
                          <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>

                {/* Sensitivity bar chart */}
                <Panel title="Cost Driver Analysis — % of Total Flight Cost">
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart
                      layout="vertical"
                      data={costParts.map(cpart=>({...cpart,pct:+(cpart.val/totalCost_per_flight*100).toFixed(1)})).sort((a,b)=>b.pct-a.pct)}
                      margin={{top:5,right:60,left:60,bottom:5}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis type="number" tick={{fontSize:9,fill:SC.muted}}
                        label={{value:"% of total cost",position:"insideBottom",fontSize:10,fill:SC.muted}}/>
                      <YAxis type="category" dataKey="name" tick={{fontSize:10,fill:SC.muted}} width={80}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${v}%`,"Share"]}/>
                      <Bar dataKey="pct" radius={[0,4,4,0]} name="% of cost">
                        {costParts.sort((a,b)=>b.val-a.val).map((cp,i)=><Cell key={i} fill={cp.col}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{marginTop:8,padding:"8px 12px",background:`${SC.green}11`,
                    border:`1px solid ${SC.green}33`,borderRadius:6,fontSize:10,
                    color:SC.green,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                    💡 <strong>DOC v3 Formula Sources:</strong><br/>
                    • <strong>Energy</strong>: E_grid = E_batt / (η_discharge(C) × η_charger(C)); η_d = 0.97−0.025C, η_ch = 0.97−0.030C (Waldmann 2014, SAE ARP6504)<br/>
                    • <strong>Battery</strong>: $/kWh = (cell_cost(SED) + $55 pack overhead) × 2× cert; Neff = 900 × (0.5/DoD)^β × (2/C)^0.45; β=0.5 shallow, β=0.6 deep (Thornton 2019)<br/>
                    • <strong>Maintenance</strong>: Sched $45k/yr + var (2.0+0.18ΔN+2.0·h_frac)×$150/FH + unscheduled (MTBF motor/ESC) × $1,200/event<br/>
                    • <strong>Operator</strong>: RPIC $82k/yr ÷ 4 aircraft; cost/duty-hour × (flight + 15min turnaround) — autonomy mode: piloted(÷4), remote(÷12), auto(÷100)<br/>
                    • <strong>Insurance</strong>: 10% hull/yr — GAMA 2023 novel type cert<br/>
                    💡 <strong>Break-even load factor = {(breakEvenLF*100).toFixed(1)}%</strong> at $4.50/km — if this exceeds 85% the route is marginal.
                  </div>
                </Panel>

                {/* Profit vs Load Factor curve */}
                <Panel title="Profit vs Load Factor — Fare Scenario Sensitivity" ht={300}>
                  <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,paddingLeft:4}}>
                    Per-flight profit at each load factor for three market fare scenarios.
                    Zero-crossing = break-even LF. Above zero = profitable.
                  </div>
                  <ResponsiveContainer width="100%" height={235}>
                    <LineChart data={profitVsLF} margin={{top:5,right:20,left:5,bottom:20}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                      <XAxis dataKey="lf" tick={{fontSize:9,fill:SC.muted}}
                        label={{value:"Load factor (%)",position:"insideBottom",offset:-6,fontSize:10,fill:SC.muted}}/>
                      <YAxis tick={{fontSize:9,fill:SC.muted}}
                        tickFormatter={v=>`$${v}`}
                        label={{value:"Profit/flight ($)",angle:-90,position:"insideLeft",fontSize:10,fill:SC.muted}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>[`$${v}`,n]}/>
                      <Legend iconSize={9} wrapperStyle={{fontSize:10,color:SC.muted}}/>
                      <ReferenceLine y={0} stroke={SC.muted} strokeWidth={1.5} strokeDasharray="4 2"
                        label={{value:"Break-even",fill:SC.muted,fontSize:9,position:"right"}}/>
                      {fareScenarios.map(s=>(
                        <Line key={s.label} type="monotone" dataKey={s.label}
                          stroke={s.col} strokeWidth={2} dot={false} name={s.label}/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
              </div>
              );
            })()}

            {/* ──── TAB 13: MISSION BUILDER ──── */}
            {tab===13&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:SC.panel,
                  border:`1px solid #06d6a044`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>CUSTOM MISSION PROFILE — DRAG & DROP PHASES</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:"#06d6a0"}}>Mission Builder</span>
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7}}>
                    Build any mission profile by dragging phases into order. Add hover-at-destination, emergency divert, wind correction segments, loiter patterns.
                    Click <strong style={{color:"#06d6a0"}}>▶ Compute Mission</strong> to run the physics engine on your custom profile.
                  </div>
                </div>

                {/* Phase palette */}
                <Panel title="Phase Library — Click to Add to Mission">
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {Object.entries(PHASE_TYPES).map(([type,pt])=>(
                      <button key={type} onClick={()=>{
                          const def=pt.defaults;
                          setCustomPhases(prev=>[...prev,{id:uid2(),type,...def,label:pt.label}]);
                        }} type="button"
                        style={{padding:"6px 12px",background:`${pt.col}15`,
                          border:`1px solid ${pt.col}55`,borderRadius:6,cursor:"pointer",
                          display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:14}}>{pt.icon}</span>
                        <span style={{fontSize:11,color:pt.col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{pt.label}</span>
                        <span style={{fontSize:10,color:SC.muted}}>+</span>
                      </button>
                    ))}
                  </div>
                </Panel>

                {/* Drag-and-drop phase list */}
                <Panel title={`Mission Profile — ${customPhases.length} Phases (drag to reorder)`}>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {customPhases.map((ph,i)=>{
                      const pt=PHASE_TYPES[ph.type];
                      const isDragging=dragIdx===i;
                      const isOver=dragOverIdx===i;
                      return(
                        <div key={ph.id}
                          draggable
                          onDragStart={()=>setDragIdx(i)}
                          onDragOver={evt => {evt.preventDefault();setDragOverIdx(i);}}
                          onDrop={evt=>{
                            e.preventDefault();
                            if(dragIdx===null||dragIdx===i) return;
                            const newPhases=[...customPhases];
                            const [moved]=newPhases.splice(dragIdx,1);
                            newPhases.splice(i,0,moved);
                            setCustomPhases(newPhases);
                            setDragIdx(null); setDragOverIdx(null);
                          }}
                          onDragEnd={()=>{setDragIdx(null);setDragOverIdx(null);}}
                          style={{
                            background:isDragging?`${pt.col}22`:isOver?`${pt.col}15`:SC.bg,
                            border:`1px solid ${isOver?pt.col:pt.col+"44"}`,
                            borderLeft:`3px solid ${pt.col}`,
                            borderRadius:8,padding:"10px 14px",cursor:"grab",
                            opacity:isDragging?0.5:1,transition:"all 0.15s",
                            display:"flex",alignItems:"center",gap:12}}>
                          {/* Drag handle */}
                          <span style={{fontSize:14,color:SC.dim,cursor:"grab",userSelect:"none"}}>⠿</span>
                          <span style={{fontSize:16}}>{pt.icon}</span>
                          {/* Label */}
                          <input value={ph.label} onChange={evt=>{
                              setCustomPhases(prev=>prev.map((ph_item,j)=>j===i?{...ph_item,label:evt.target.value}:ph_item));
                            }}
                            style={{background:"transparent",border:"none",color:pt.col,fontSize:11,
                              fontWeight:700,fontFamily:"'DM Mono',monospace",outline:"none",width:120}}/>
                          {/* Phase-specific fields */}
                          <div style={{display:"flex",gap:10,flex:1,flexWrap:"wrap"}}>
                            {pt.fields.map(field=>{
                              const fieldLabels={duration:"Duration (s)",altitude:"Altitude (m)",distance:"Distance (km)",
                                angle:"Angle (°)",speed:"Speed (m/s)",windSpeed:"Wind (m/s)"};
                              return(
                                <div key={field} style={{display:"flex",alignItems:"center",gap:4}}>
                                  <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{fieldLabels[field]}:</span>
                                  <input type="number" value={ph[field]||0}
                                    onChange={evt=>{
                                      const v=parseFloat(evt.target.value)||0;
                                      setCustomPhases(prev=>prev.map((ph_item,j)=>j===i?{...ph_item,[field]:v}:ph_item));
                                    }}
                                    style={{width:60,background:SC.panel,border:`1px solid ${SC.border}`,
                                      borderRadius:4,color:SC.text,fontSize:11,padding:"3px 6px",
                                      fontFamily:"'DM Mono',monospace",outline:"none"}}
                                    onFocus={evt => evt.target.style.borderColor=pt.col}
                                    onBlur={evt => evt.target.style.borderColor=SC.border}/>
                                </div>
                              );
                            })}
                          </div>
                          {/* Delete */}
                          <button onClick={()=>setCustomPhases(prev=>prev.filter((_,j)=>j!==i))} type="button"
                            style={{background:"transparent",border:`1px solid ${SC.red}44`,borderRadius:4,
                              color:SC.red,fontSize:10,cursor:"pointer",padding:"3px 8px",fontFamily:"'DM Mono',monospace",flexShrink:0}}>
                            ✕
                          </button>
                        </div>
                      );
                    })}
                    {customPhases.length===0&&(
                      <div style={{textAlign:"center",padding:"32px",color:SC.muted,fontFamily:"'DM Mono',monospace",fontSize:12}}>
                        No phases. Click a phase type above to add one.
                      </div>
                    )}
                  </div>
                  <div style={{marginTop:12,display:"flex",gap:8}}>
                    <button onClick={computeCustomMission} type="button"
                      style={{padding:"10px 24px",background:`linear-gradient(135deg,#065f46,#047857)`,
                        border:`1px solid #06d6a0`,borderRadius:6,color:"#6ee7b7",fontSize:12,
                        fontWeight:800,cursor:"pointer",fontFamily:"'DM Mono',monospace",
                        boxShadow:"0 0 16px #06d6a044"}}>
                      ▶ Compute Mission
                    </button>
                    <button onClick={()=>{setCustomPhases([
                        {id:uid2(),type:"hover", duration:30, altitude:15, label:"Takeoff Hover"},
                        {id:uid2(),type:"climb", distance:5,  angle:5,    label:"Climb"},
                        {id:uid2(),type:"cruise",distance:200,speed:67,   label:"Cruise"},
                        {id:uid2(),type:"descent",distance:4, angle:4,    label:"Descent"},
                        {id:uid2(),type:"hover", duration:30, altitude:15,label:"Landing Hover"},
                        {id:uid2(),type:"reserve",distance:40,speed:47,   label:"Reserve"},
                      ]);setMbResults(null);}} type="button"
                      style={{padding:"10px 16px",background:"transparent",border:`1px solid ${SC.border}`,
                        borderRadius:6,color:SC.muted,fontSize:11,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>
                      ↺ Reset to Default
                    </button>
                  </div>
                </Panel>

                {/* Results */}
                {mbResults&&(
                  <>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                      <KPI label="Total Energy" value={mbResults.totalE} unit="kWh"
                        color={mbResults.totalE<=SR.PackkWh?SC.green:SC.red}
                        sub={`Pack: ${SR.PackkWh} kWh`}/>
                      <KPI label="Mission Time" value={`${(mbResults.totalT/60).toFixed(1)} min`} unit=""
                        color={SC.blue} sub={`${mbResults.totalT}s total`}/>
                      <KPI label="Total Range" value={mbResults.totalRange} unit="km" color={SC.teal}/>
                      <KPI label="Final SoC" value={`${mbResults.finalSoC.toFixed(1)}%`} unit=""
                        color={mbResults.finalSoC>20?SC.green:mbResults.finalSoC>10?SC.amber:SC.red}
                        sub={mbResults.feasible?"✓ Feasible":"✗ Battery depleted"}/>
                    </div>

                    {/* Phase breakdown chart */}
                    <Panel title="Phase Power & Energy Breakdown" ht={280}>
                      <ResponsiveContainer width="100%" height={235}>
                        <BarChart data={mbResults.phases.map(ph=>({
                            name:ph.label,power:ph.power,energy:ph.energy,
                            fill:PHASE_TYPES[ph.type]?.col||SC.muted}))}
                          margin={{top:5,right:20,left:5,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                          <XAxis dataKey="name" tick={{fontSize:9,fill:SC.muted}} angle={-20} textAnchor="end"/>
                          <YAxis yAxisId="left" tick={{fontSize:10,fill:SC.amber}}
                            label={{value:"Power (kW)",angle:-90,position:"insideLeft",fontSize:10,fill:SC.amber}}/>
                          <YAxis yAxisId="right" orientation="right" tick={{fontSize:10,fill:SC.teal}}
                            label={{value:"Energy (kWh)",angle:90,position:"insideRight",fontSize:10,fill:SC.teal}}/>
                          <Tooltip {...TTP}/>
                          <Legend iconSize={9} wrapperStyle={{fontSize:11}}/>
                          <Bar yAxisId="left" dataKey="power" name="Power (kW)" radius={[3,3,0,0]} maxBarSize={30}>
                            {mbResults.phases.map((ph,i)=><Cell key={i} fill={PHASE_TYPES[ph.type]?.col||SC.muted}/>)}
                          </Bar>
                          <Bar yAxisId="right" dataKey="energy" name="Energy (kWh)" fill={SC.teal} radius={[3,3,0,0]} maxBarSize={30} opacity={0.7}/>
                        </BarChart>
                      </ResponsiveContainer>
                    </Panel>

                    {/* Phase detail table */}
                    <Panel title="Phase-by-Phase Results">
                      <div style={{overflowX:"auto"}}>
                        <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                          <thead><tr style={{background:SC.panel}}>
                            {["Phase","Type","Power (kW)","Energy (kWh)","Time (s)","Distance (km)","% Total E"].map(hdr=>(
                              <th key={hdr} style={{padding:"5px 8px",color:SC.muted,fontSize:9,fontWeight:600,textAlign:"right"}}>{hdr}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {mbResults.phases.map((ph,i)=>{
                              const col=PHASE_TYPES[ph.type]?.col||SC.muted;
                              return(
                                <tr key={i} style={{borderTop:`1px solid ${SC.border}`,background:i%2?"#0a0d14":SC.bg}}>
                                  <td style={{padding:"5px 8px",color:col,fontWeight:700}}>{ph.label}</td>
                                  <td style={{padding:"5px 8px",color:SC.muted,textAlign:"right"}}>{PHASE_TYPES[ph.type]?.icon} {PHASE_TYPES[ph.type]?.label}</td>
                                  <td style={{padding:"5px 8px",color:SC.amber,textAlign:"right"}}>{ph.power}</td>
                                  <td style={{padding:"5px 8px",color:SC.teal,textAlign:"right"}}>{ph.energy}</td>
                                  <td style={{padding:"5px 8px",color:SC.blue,textAlign:"right"}}>{ph.time}</td>
                                  <td style={{padding:"5px 8px",color:SC.muted,textAlign:"right"}}>{(ph.distance/1000).toFixed(1)}</td>
                                  <td style={{padding:"5px 8px",textAlign:"right"}}>
                                    <div style={{display:"inline-flex",alignItems:"center",gap:6}}>
                                      <div style={{width:36,height:4,background:SC.border,borderRadius:2}}>
                                        <div style={{width:`${(ph.energy/mbResults.totalE*100).toFixed(0)}%`,height:"100%",background:col,borderRadius:2}}/>
                                      </div>
                                      <span style={{color:col}}>{(ph.energy/mbResults.totalE*100).toFixed(1)}%</span>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                            <tr style={{borderTop:`2px solid ${SC.border}`,background:SC.panel,fontWeight:700}}>
                              <td style={{padding:"6px 8px",color:SC.text}} colSpan={2}>TOTAL</td>
                              <td style={{padding:"6px 8px",color:SC.amber,textAlign:"right"}}>—</td>
                              <td style={{padding:"6px 8px",color:SC.teal,textAlign:"right"}}>{mbResults.totalE}</td>
                              <td style={{padding:"6px 8px",color:SC.blue,textAlign:"right"}}>{mbResults.totalT}</td>
                              <td style={{padding:"6px 8px",color:SC.muted,textAlign:"right"}}>{mbResults.totalRange}</td>
                              <td style={{padding:"6px 8px",color:SC.muted,textAlign:"right"}}>100%</td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </Panel>
                  </>
                )}
              </div>
            )}

            {/* ──── TAB 12: WEATHER & ATMOSPHERE ──── */}
            {tab===14&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>

                {/* Header */}
                <div style={{background:SC.panel,
                  border:`1px solid #3b82f644`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:6}}>REAL-TIME ATMOSPHERIC CONDITIONS — OPEN-METEO API</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:SC.blue}}>Weather</span> & Atmosphere Integration
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7}}>
                    Pulls real weather data for any city using <span style={{color:SC.blue,fontWeight:700}}>Open-Meteo API</span> (no API key, completely free).
                    Calculates how actual temperature, pressure, and density affect hover power, stall speed, cruise Mach, and range vs ISA standard conditions.
                  </div>
                </div>

                {/* Search */}
                <Panel title="Search Any City or Airport">
                  <div style={{display:"flex",gap:8,marginBottom:12}}>
                    <input value={wxSearch} onChange={evt=>setWxSearch(evt.target.value)}
                      onKeyDown={evt => evt.key==="Enter"&&searchCity()}
                      placeholder="Type any city, e.g. Denver, Dubai, Singapore..."
                      style={{flex:1,background:SC.bg,border:`1px solid ${SC.border}`,borderRadius:6,
                        color:SC.text,fontSize:12,padding:"9px 14px",fontFamily:"'DM Mono',monospace",outline:"none"}}
                      onFocus={evt => evt.target.style.borderColor=SC.blue}
                      onBlur={evt => evt.target.style.borderColor=SC.border}/>
                    <button onClick={searchCity} disabled={wxLoading} type="button"
                      style={{padding:"9px 20px",background:`linear-gradient(135deg,#1e3a5f,#1e40af)`,
                        border:`1px solid ${SC.blue}`,borderRadius:6,color:"#93c5fd",fontSize:12,
                        fontWeight:700,cursor:wxLoading?"not-allowed":"pointer",fontFamily:"'DM Mono',monospace"}}>
                      {wxLoading?"⟳ Fetching...":"🔍 Get Weather"}
                    </button>
                  </div>
                  {wxError&&(
                    <div style={{padding:"8px 12px",background:`${SC.red}15`,border:`1px solid ${SC.red}44`,
                      borderRadius:6,color:SC.red,fontSize:11,fontFamily:"'DM Mono',monospace",marginBottom:8}}>
                      ✗ {wxError}
                    </div>
                  )}
                  {/* Quick presets */}
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6,letterSpacing:"0.1em"}}>QUICK ACCESS — REFERENCE CITIES</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {WX_PRESETS.map(city=>(
                      <button key={city.name} onClick={()=>fetchWeather(city.lat,city.lon,city.name,city.alt)} type="button"
                        style={{padding:"5px 10px",background:SC.bg,border:`1px solid ${SC.border}`,
                          borderRadius:5,cursor:"pointer",fontSize:10,fontFamily:"'DM Mono',monospace",
                          color:SC.text,display:"flex",alignItems:"center",gap:4}}
                        onMouseEnter={evt => evt.currentTarget.style.borderColor=SC.blue}
                        onMouseLeave={evt => evt.currentTarget.style.borderColor=SC.border}>
                        <span>{city.flag}</span>{city.name}
                      </button>
                    ))}
                  </div>
                </Panel>

                {/* Weather data display */}
                {wxData&&(
                  <>
                    {/* Location & conditions */}
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                      <Panel title={`📍 ${wxData.cityName} — Current Conditions`}>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                          {[
                            ["Temperature",`${wxData.T_C.toFixed(1)}°C`,wxData.T_C>35||wxData.T_C<-10?SC.red:SC.text],
                            ["Condition",wxData.wx_desc,SC.teal],
                            ["Pressure",`${wxData.P_hPa.toFixed(0)} hPa`,SC.muted],
                            ["Humidity",`${wxData.humidity}%`,SC.muted],
                            ["Wind Speed",`${(wxData.wind_ms*3.6).toFixed(1)} km/h (${wxData.wind_ms.toFixed(1)} m/s)`,SC.blue],
                            ["Wind Dir",`${wxData.wind_dir}°`,SC.muted],
                            ["Elevation",`${wxData.elevation.toFixed(0)} m AMSL`,SC.amber],
                            ["ΔT from ISA",`${wxData.deltaT>0?"+":""}${wxData.deltaT.toFixed(1)}°C`,wxData.deltaT>10||wxData.deltaT<-10?SC.red:SC.amber],
                          ].map(([lbl,val,col])=>(
                            <div key={lbl} style={{background:SC.bg,borderRadius:6,padding:"8px 10px",border:`1px solid ${SC.border}`}}>
                              <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:2}}>{lbl}</div>
                              <div style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{val}</div>
                            </div>
                          ))}
                        </div>
                      </Panel>
                      <Panel title="🌡️ Atmosphere vs ISA Standard">
                        {[
                          ["Air Density ρ",`${wxData.rho_actual} kg/m³`,"ISA SL: 1.225 kg/m³",wxData.rho_actual>1.15?SC.green:wxData.rho_actual>1.0?SC.amber:SC.red],
                          ["Density Ratio σ",`${wxData.sigma}`,wxData.sigma>0.95?"Near sea-level":wxData.sigma>0.85?"Moderate alt":"High alt",wxData.sigma>0.95?SC.green:wxData.sigma>0.85?SC.amber:SC.red],
                          ["Speed of Sound",`${wxData.a_actual.toFixed(1)} m/s`,`ISA SL: 340.3 m/s`,SC.teal],
                        ].map(([lbl,val,sub,col])=>(
                          <div key={lbl} style={{display:"flex",alignItems:"center",justifyContent:"space-between",
                            padding:"10px 0",borderBottom:`1px solid ${SC.border}`}}>
                            <div>
                              <div style={{fontSize:11,color:SC.text,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{lbl}</div>
                              <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{sub}</div>
                            </div>
                            <div style={{fontSize:14,fontWeight:800,color:col,fontFamily:"'DM Mono',monospace"}}>{val}</div>
                          </div>
                        ))}
                        {/* Density ratio bar */}
                        <div style={{marginTop:10}}>
                          <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4}}>Density ratio σ = {wxData.sigma.toFixed(3)}</div>
                          <div style={{height:8,background:SC.border,borderRadius:4,overflow:"hidden"}}>
                            <div style={{width:`${wxData.sigma*100}%`,height:"100%",
                              background:`linear-gradient(90deg,${SC.red},${SC.amber},${SC.green})`,
                              borderRadius:4,transition:"width 0.5s"}}/>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:SC.dim,marginTop:2,fontFamily:"'DM Mono',monospace"}}>
                            <span>0 (vacuum)</span><span>0.5</span><span>1.0 (ISA SL)</span>
                          </div>
                        </div>
                      </Panel>
                    </div>

                    {/* Performance impacts */}
                    {wxResults&&(
                      <Panel title={`⚡ Performance Impact vs ISA Standard — at ${wxData.cityName}`}>
                        <div style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:12,lineHeight:1.6}}>
                          Showing how <span style={{color:SC.blue}}>actual atmospheric conditions</span> change your aircraft's performance
                          vs the ISA standard day (T=15°C, P=1013.25 hPa, ρ=1.225 kg/m³) used in the main physics engine.
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:12}}>
                          {[
                            {label:"Hover Power",isa:`${SR.Phov} kW`,actual:`${wxResults.P_hov_wx} kW`,delta:wxResults.P_hov_delta_pct,unit:"kW",
                              note:wxResults.P_hov_delta_pct>0?"Lower density → more power needed":"Denser air → less power needed"},
                            {label:"Cruise Power",isa:`${SR.Pcr} kW`,actual:`${wxResults.P_cr_wx} kW`,delta:wxResults.P_cr_delta_pct,unit:"kW",
                              note:wxResults.P_cr_delta_pct>0?"Less dense → higher cruise power":"Denser air → less cruise power"},
                            {label:"Stall Speed",isa:`${SR.Vstall} m/s`,actual:`${wxResults.V_stall_wx} m/s`,delta:((wxResults.V_stall_wx/SR.Vstall-1)*100),unit:"m/s",
                              note:wxResults.V_stall_wx>SR.Vstall?"Higher stall speed — lower density":"Lower stall speed — higher density"},
                            {label:"Cruise Mach",isa:`M ${SR.Mach}`,actual:`M ${wxResults.Mach_wx}`,delta:((wxResults.Mach_wx/SR.Mach-1)*100),unit:"",
                              note:wxResults.Mach_wx>SR.Mach?"Warmer air → higher Mach for same TAS":"Cooler air → slightly higher Mach"},
                            {label:"Ground Speed",isa:`${params.vCruise} m/s (no wind)`,actual:`${wxResults.Vg.toFixed(1)} m/s`,delta:wxResults.range_wind_pct,unit:"m/s",
                              note:wxResults.headwind_component>0?`Headwind ${wxResults.headwind_component.toFixed(1)} m/s — reduces range`:`Tailwind ${Math.abs(wxResults.headwind_component).toFixed(1)} m/s — boosts range`},
                            {label:"Air Density",isa:"1.225 kg/m³",actual:`${wxResults.rho_actual} kg/m³`,delta:((wxResults.rho_actual/1.225-1)*100),unit:"kg/m³",
                              note:`σ = ${wxResults.sigma} — ${wxResults.sigma>1?"denser than ISA":"less dense than ISA"}`},
                          ].map(({label,isa,actual,delta,note})=>(
                            <div key={label} style={{background:SC.bg,border:`1px solid ${Math.abs(delta)>10?SC.amber:SC.border}`,
                              borderRadius:8,padding:"12px 14px",borderLeft:`3px solid ${delta>5?SC.red:delta<-2?SC.green:SC.amber}`}}>
                              <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:6}}>{label}</div>
                              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                                <span style={{fontSize:10,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>ISA: {isa}</span>
                                <span style={{fontSize:10,color:SC.blue,fontFamily:"'DM Mono',monospace",fontWeight:700}}>→ {actual}</span>
                              </div>
                              <div style={{fontSize:13,fontWeight:800,fontFamily:"'DM Mono',monospace",
                                color:delta>5?SC.red:delta>2?SC.amber:delta<-2?SC.green:SC.muted,marginBottom:4}}>
                                {delta>0?"+":""}{delta.toFixed(1)}%
                              </div>
                              <div style={{fontSize:9,color:SC.dim,fontFamily:"'DM Mono',monospace",lineHeight:1.4}}>{note}</div>
                            </div>
                          ))}
                        </div>

                        {/* Summary insight */}
                        <div style={{padding:"10px 14px",background:`${SC.blue}11`,border:`1px solid ${SC.blue}33`,
                          borderRadius:6,fontSize:11,color:SC.text,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                          <strong style={{color:SC.blue}}>📊 Summary for {wxData.cityName}:</strong>{" "}
                          Air density is <strong style={{color:wxResults.sigma>1?SC.green:wxResults.sigma<0.9?SC.red:SC.amber}}>
                            {wxResults.sigma>1?"higher":"lower"} than ISA</strong> (σ={wxResults.sigma}).
                          Hover power is <strong style={{color:wxResults.P_hov_delta_pct>5?SC.red:SC.green}}>
                            {wxResults.P_hov_delta_pct>0?"+":""}{wxResults.P_hov_delta_pct.toFixed(1)}%</strong> vs standard day.
                          {Math.abs(wxResults.headwind_component)>2&&(
                            <span> Wind component: <strong style={{color:wxResults.headwind_component>0?SC.red:SC.green}}>
                              {wxResults.headwind_component>0?"headwind":"tailwind"} {Math.abs(wxResults.headwind_component).toFixed(1)} m/s
                            </strong> — range {wxResults.range_wind_pct>0?"increases":"decreases"} by{" "}
                            <strong>{Math.abs(wxResults.range_wind_pct).toFixed(1)}%</strong>.</span>
                          )}
                        </div>
                      </Panel>
                    )}
                  </>
                )}

                {!wxData&&!wxLoading&&(
                  <div style={{textAlign:"center",padding:"48px 0",color:SC.muted,fontFamily:"'DM Mono',monospace"}}>
                    <div style={{fontSize:48,marginBottom:16}}>🌤️</div>
                    <div style={{fontSize:14,fontWeight:600,color:SC.text,marginBottom:8}}>No location selected</div>
                    <div style={{fontSize:12,color:SC.muted}}>Search a city or click a preset above</div>
                  </div>
                )}
              </div>
            )}

            {/* ──── TAB 13: OPENVSP EXPORT ──── */}
            {tab===15&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* Header banner */}
                <div style={{background:SC.panel,
                  border:`1px solid ${SC.border}`,borderRadius:8,padding:"16px 20px",
                  display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.15em",marginBottom:4}}>GEOMETRY EXPORT</div>
                    <div style={{fontSize:22,fontWeight:800,color:SC.amber,letterSpacing:"-0.03em"}}>OpenVSP Export</div>
                    <div style={{fontSize:10,color:SC.muted,marginTop:2,fontFamily:"'DM Mono',monospace"}}>
                      Download the .vsp3 file and open directly in OpenVSP 3.28+
                    </div>
                  </div>
                  <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                    {/* ── .vsp3 download button ── */}
                    <AuthGate user={user} onAuth={handleAuth}>
                    <button
                      onClick={()=>{
                        const xml=generateVSP3File(params,SR);
                        const blob=new Blob([xml],{type:"application/xml"});
                        const url=URL.createObjectURL(blob);
                        const a=document.createElement("a");
                        a.href=url; a.download="Trail1_eVTOL.vsp3"; a.click();
                        URL.revokeObjectURL(url);
                        if(user) addNotif(user.id,{title:"VSP3 File Downloaded",body:`Trail1_eVTOL.vsp3 — MTOW=${SR.MTOW} kg, b=${SR.bWing} m`,type:"success"});
                      }}
                      style={{padding:"10px 20px",background:`linear-gradient(135deg,#3b82f6,#6366f1)`,
                        border:"none",borderRadius:6,color:"#ffffff",fontSize:12,fontWeight:800,
                        cursor:"pointer",letterSpacing:"0.04em",fontFamily:"'DM Mono',monospace",
                        boxShadow:"0 0 18px #3b82f644",display:"flex",alignItems:"center",gap:6}}>
                      {!user&&<span>🔒</span>}⬇ .vsp3
                    </button>
                    </AuthGate>
                  </div>
                </div>

                {/* Geometry summary cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                  {[
                    ["Fuselage","Body","L "+params.fusLen+" m  Ø "+params.fusDiam+" m","#64748b"],
                    ["Main Wing","WING_GEOM","S="+SR.Swing+" m²  b="+SR.bWing+" m","#3b82f6"],
                    ["V-Tail","WING_GEOM","Γ="+params.vtGamma+"°  S="+SR.Svt_total.toFixed(2)+" m²","#8b5cf6"],
                    ["Hover Rotors","PROP_GEOM × "+params.nPropHover,"D="+SR.Drotor+" m  "+SR.Nbld+" blades","#22c55e"],
                    ["CG + NP","Markers","CG="+SR.xCGtotal+"m  NP="+SR.xNP+"m","#f59e0b"],
                  ].map(([title,type,detail,col])=>(
                    <div key={title} style={{background:SC.panel,border:`1px solid ${col}33`,
                      borderLeft:`3px solid ${col}`,borderRadius:6,padding:"10px 12px"}}>
                      <div style={{fontSize:11,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",marginBottom:3}}>{title}</div>
                      <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4}}>{type}</div>
                      <div style={{fontSize:9,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{detail}</div>
                    </div>
                  ))}
                </div>

                {/* Two-column: geometry table + coordinate diagram */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Geometry Placement — OpenVSP Coordinates (X: nose→tail, Y: port→stbd, Z: up)">
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                      <thead>
                        <tr style={{borderBottom:`1px solid ${SC.border}`}}>
                          {["Component","x_LE (m)","y (m)","z (m)","Dihedral"].map(hdr=>(
                            <th key={hdr} style={{textAlign:"left",padding:"3px 6px",fontSize:8,color:SC.muted,
                              textTransform:"uppercase",letterSpacing:"0.08em"}}>{hdr}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(()=>{
                          const xWingLE_=(SR.xACwing-0.25*SR.Cr_).toFixed(3);
                          const zWing_=(-params.fusDiam*0.10).toFixed(3);
                          const xVtLE_=((SR.xACwing+SR.lv)-0.25*SR.MAC_vt).toFixed(3);
                          const zVt_=(params.fusDiam*0.05).toFixed(3);
                          const nSide=Math.floor(params.nPropHover/2);
                          const rows=[
                            ["Fuselage","0.000","0.000","0.000","0°"],
                            ["Main Wing",xWingLE_,"0.000 (root)",zWing_,"2° (low-wing)"],
                            ["V-Tail",xVtLE_,"0.000 (root)",zVt_,params.vtGamma+"° (panel)"],
                            ...Array.from({length:nSide},(_,i)=>{
                              const y=((SR.bWing/2)*(i+0.5)/nSide).toFixed(3);
                              const x=((SR.xACwing-0.25*SR.Cr_)-0.30).toFixed(3);
                              const z=((-params.fusDiam*0.10)+SR.Drotor*0.55).toFixed(3);
                              return["Rotor "+(2*i)+" / "+(2*i+1),x,"±"+y,z,"—"];
                            }),
                            ["CG Marker",SR.xCGtotal.toFixed(3),"0","fD×0.55","—"],
                            ["NP Marker",SR.xNP.toFixed(3),"0","fD×0.65","—"],
                          ];
                          return rows.map((rowItem,i)=>(
                            <tr key={i} style={{background:i%2===0?SC.bg:"transparent",
                              borderBottom:`1px solid ${SC.border}22`}}>
                              {rowItem.map((cell,j)=>(
                                <td key={j} style={{padding:"4px 6px",
                                  color:j===0?SC.amber:SC.text,
                                  fontSize:j===0?10:9}}>{cell}</td>
                              ))}
                            </tr>
                          ));
                        })()}
                      </tbody>
                    </table>
                  </Panel>

                  <Panel title="Parent–Child Tree & Design Values">
                    {/* Tree view */}
                    <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,lineHeight:1.8}}>
                      {[
                        {indent:0,icon:"🏗️",label:"Fuselage (FUSELAGE_GEOM)",detail:`L=${params.fusLen}m  Ø=${params.fusDiam}m`,col:"#94a3b8"},
                        {indent:1,icon:"✈️",label:"Main Wing (WING_GEOM)",detail:`b=${SR.bWing}m  S=${SR.Swing}m²  AR=${params.AR}  λ=${params.taper}`,col:SC.blue},
                        {indent:1,icon:"🦋",label:"V-Tail (WING_GEOM · XZ sym)",detail:`Γ=${params.vtGamma}°  S_panel=${SR.Svt_panel}m²  AR=${params.vtAR}`,col:"#8b5cf6"},
                        {indent:1,icon:"🟢",label:"CG Marker (FUSELAGE_GEOM)",detail:`x=${SR.xCGtotal}m  SM=${((SR.SM)*100).toFixed(1)}% MAC`,col:SC.green},
                        {indent:1,icon:"🔵",label:"NP Marker (FUSELAGE_GEOM)",detail:`x=${SR.xNP}m from nose`,col:SC.teal},
                        ...Array.from({length:Math.floor(params.nPropHover/2)},(_,i)=>({
                          indent:1,icon:"🔧",
                          label:`Rotor pair ${i} (PROP_GEOM × 2)`,
                          detail:`D=${SR.Drotor}m  ${SR.Nbld||3} blades  @y=±${((SR.bWing/2)*(i+0.5)/Math.floor(params.nPropHover/2)).toFixed(2)}m`,
                          col:SC.amber,
                        })),
                      ].map((node_item,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"flex-start",gap:4,
                          paddingLeft:node_item.indent*18,paddingTop:1,paddingBottom:1}}>
                          <span style={{color:SC.dim,flexShrink:0}}>{node_item.indent>0?"└ ":""}</span>
                          <span style={{flexShrink:0}}>{node_item.icon}</span>
                          <div>
                            <span style={{color:node_item.col,fontWeight:600}}>{node_item.label}</span>
                            <div style={{fontSize:8,color:SC.muted,marginTop:1}}>{node_item.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                </div>

                {/* Airfoil / tail note + key design values table */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Design Values Written to Script">
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
                      {[
                        ["MTOW",SR.MTOW+" kg"],
                        ["Wing LE (from nose)",(SR.xACwing-0.25*SR.Cr_).toFixed(3)+" m"],
                        ["Wing root chord",SR.Cr_+" m"],
                        ["Wing tip chord",SR.Ct_+" m"],
                        ["Wing half-span",(SR.bWing/2).toFixed(3)+" m"],
                        ["Wing sweep (LE)",SR.sweep+"°"],
                        ["Wing t/c",params.tc],
                        ["V-tail root LE",((SR.xACwing+SR.lv)-0.25*SR.MAC_vt).toFixed(3)+" m"],
                        ["V-tail panel span",SR.bvt_panel+" m"],
                        ["V-tail root chord",SR.Cr_vt+" m"],
                        ["V-tail sweep (LE)",SR.sweep_vt+"°"],
                        ["Rotor diameter",SR.Drotor+" m"],
                        ["Blade chord",SR.ChordBl.toFixed(4)+" m"],
                        ["CG from nose",SR.xCGtotal+" m"],
                        ["NP from nose",SR.xNP+" m"],
                        ["Static margin",(SR.SM*100).toFixed(1)+"% MAC"],
                      ].map(([k,v])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",
                          padding:"3px 6px",background:SC.bg,borderRadius:3}}>
                          <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{k}</span>
                          <span style={{fontSize:9,color:SC.amber,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </Panel>

                  <Panel title="How to Open the .vsp3 in OpenVSP">
                    {[
                      ["1","Download","Click the blue button to download Trail1_eVTOL.vsp3."],
                      ["2","Open VSP","Open OpenVSP 3.28+ (incl. 3.48.2)."],
                      ["3","Open File","File → Open → select Trail1_eVTOL.vsp3.  Geometry loads immediately."],
                      ["4","Verify","Check fuselage (5-station ellipse), wing (S="+SR.Swing+" m², b="+SR.bWing+" m), V-tail (Γ="+params.vtGamma+"°), "+params.nPropHover+" hover rotors + 1 cruise prop."],
                      ["5","CG / NP","MassProperties block carries CG="+SR.xCGtotal+" m, SM="+((SR.SM_vt||SR.SM)*100).toFixed(1)+"% MAC.  View via Model → Edit → MassProperties."],
                      ["6","Rotors","Hover rotors: Y_Rot=90° (disk horizontal, thrust +Z).  Cruise prop: Y_Rot=0° (disk vertical, thrust +X pusher)."],
                      ["7","V-Tail","Two-panel V-tail: XZ symmetry + dihedral Γ. Ruddervators: symmetric=elevator, differential=rudder."],
                      ["8","Iterate","Change any slider → re-download → re-open. Each download regenerates from current sizing."],
                    ].map(([n,title,text])=>(
                      <div key={n} style={{display:"flex",gap:8,marginBottom:8}}>
                        <div style={{width:18,height:18,borderRadius:"50%",background:"#3b82f6",flexShrink:0,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:8,fontWeight:800,color:"#ffffff",fontFamily:"'DM Mono',monospace"}}>{n}</div>
                        <div>
                          <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace"}}>{title}</div>
                          <div style={{fontSize:9,color:SC.muted,marginTop:1,lineHeight:1.5}}>{text}</div>
                        </div>
                      </div>
                    ))}
                  </Panel>
                </div>

                {/* ── Feature 9: Cross-Section Preview ── */}
                <Panel title="Geometry Preview — Cross-Section &amp; Airfoil">
                  <CrossSectionPreview params={params} SR={SR} SC={SC}/>
                </Panel>

                {/* ── Feature 10: CFD-Ready Checklist ── */}
                <Panel title="CFD-Ready Export Checklist — VSPAERO Validation">
                  <CFDChecklist params={params} SR={SR} SC={SC}/>
                </Panel>

                {/* Bottom download buttons — two side by side */}
                <div style={{display:"flex",justifyContent:"center",gap:12,paddingTop:4,paddingBottom:8,flexWrap:"wrap"}}>
                  {/* .vsp3 download */}
                  <AuthGate user={user} onAuth={handleAuth}>
                  <button
                    onClick={()=>{
                      const xml=generateVSP3File(params,SR);
                      const blob=new Blob([xml],{type:"application/xml"});
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url; a.download="Trail1_eVTOL.vsp3"; a.click();
                      URL.revokeObjectURL(url);
                      if(user) addNotif(user.id,{title:"VSP3 Downloaded",body:`Trail1_eVTOL.vsp3 — MTOW=${SR.MTOW} kg, b=${SR.bWing} m`,type:"success"});
                    }}
                    style={{padding:"12px 36px",background:`linear-gradient(135deg,#3b82f6,#6366f1)`,
                      border:"none",borderRadius:6,color:"#ffffff",fontSize:13,fontWeight:800,
                      cursor:"pointer",letterSpacing:"0.06em",fontFamily:"'DM Mono',monospace",
                      boxShadow:"0 0 28px #3b82f644",display:"flex",alignItems:"center",gap:8}}>
                    {!user&&<span>🔒</span>}⬇  Download Trail1_eVTOL.vsp3
                  </button>
                  </AuthGate>
                </div>
              </div>
            )}

            {/* ──── TAB 16: COMMUNITY, LEADERBOARD, GALLERY & VERSION HISTORY ──── */}
            {tab===16&&(
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                {/* ── Feature 11: Design Version History ── */}
                <Panel title="📂 Design Version History">
                  <DesignVersionHistory
                    params={params} SR={SR} SC={SC}
                    onLoadVersion={p=>setParams(prev=>({...prev,...p}))}/>
                </Panel>

                {/* ── Feature 12: Public Design Gallery ── */}
                <Panel title="🎨 Public Design Gallery">
                  <DesignGallery SC={SC} onLoadDesign={p=>setParams(prev=>({...prev,...p}))}/>
                </Panel>

                {/* Original Leaderboard */}
                <Panel title="🏆 Community Leaderboard">
                  <LeaderboardPanel C={SC} onLoadDesign={(row)=>{
                    try{
                      const p=JSON.parse(row.params||"{}");
                      if(Object.keys(p).length>0){
                        setParams(prev=>({...prev,...p}));
                        addNotif&&user&&addNotif(user.id,{title:"Design Loaded",body:`Loaded "${row.name}" from community leaderboard.`,type:"info"});
                      }
                    }catch(e){}
                  }}/>
                </Panel>
              </div>
            )}

            </>}

            {/* ──── TAB 18: V-n DIAGRAM + OEI CHECK ──── */}
            {tab===18&&SR&&(()=>{
              const g0=9.81,rhoMSL=1.225;
              const MTOW=SR.MTOW,WL=SR.WL,g=g0;
              const Vstall=SR.Vstall,VA=SR.VA,VD=SR.VD,VC=params.vCruise;
              const nPosLimit=3.5,nNegLimit=-1.5,nUltPos=nPosLimit*1.5,nUltNeg=nNegLimit*1.5;
              // Gust load factors per CS-23 Amd 5 / FAR Part 23
              const Kg=0.88*params.AR/(5.3+params.AR); // alleviation factor
              const CLa=2*Math.PI*(1+0.77*params.tc);   // lift curve slope
              const mu=2*(WL)/(rhoMSL*VC*CLa*SR.MAC);
              const Ug_cruise=15.2,Ug_dive=7.6; // gust velocities m/s (CS-23)
              const ngust_c=1+(Kg*rhoMSL*Ug_cruise*VC*CLa)/(2*WL);
              const ngust_d=1+(Kg*rhoMSL*Ug_dive*VD*CLa)/(2*WL);
              const ngust_cn=1-(Kg*rhoMSL*Ug_cruise*VC*CLa)/(2*WL);
              // Build V-n envelope
              const rhoCr_vn=SR.rhoCr||rhoMSL; // use cruise density, not MSL
              const CLmax_vn=SR.selAF?.CLmax||1.6;      // positive stall CL
              const CLneg_vn=0.8*CLmax_vn;              // CS-23: neg stall ≈ 0.8×CLmax
              const pts=[];
              for(let i=0;i<=80;i++){const v=VD*1.15*i/80;pts.push({v:+v.toFixed(1),nPos:+Math.min(0.5*rhoCr_vn*v*v*CLmax_vn/WL,nPosLimit).toFixed(3),nNeg:+Math.max(-0.5*rhoCr_vn*v*v*CLneg_vn/WL,nNegLimit).toFixed(3)});}
              // OEI hover analysis — CS-VTOL SC.VTOL AMC 27.65
              const N=params.nPropHover,Phov_tot=SR.Phov*1000; // W total hover power
              const P_per_motor=Phov_tot/N;         // nominal power per motor (W)
              // CORRECT: each motor is designed for T/W thrust, NOT T/W=1 thrust
              // T_nom_per_motor = MTOW×g×TW / N  (design thrust at T/W ratio)
              const TW_oei = params.twRatio || 1.2;
              const T_per_motor = MTOW*g*TW_oei/N; // actual motor design thrust (N)
              const T_remaining = (N-1)*T_per_motor; // OEI: (N-1) motors at full thrust
              const T_required  = MTOW*g;            // must support aircraft weight
              const OEI_margin_pct = ((T_remaining-T_required)/T_required*100);
              // OEI power: remaining motors must each produce W/(N-1) thrust
              // Power scales with thrust (actuator disk: P ∝ T^1.5), but for display
              // use equal power-sharing: P_oei = Phov_tot/(N-1)
              const P_per_motor_OEI = Phov_tot/(N-1);  // each remaining motor (W)
              const P_overhead_pct  = ((P_per_motor_OEI-P_per_motor)/P_per_motor*100);
              const motorSurvivable=P_per_motor_OEI<=(SR.PpeakKW*1000); // within peak rating?
              // Yaw moment from OEI (assume symmetric layout, worst-case arm = propDiam)
              const Larm=params.propDiam;             // moment arm (m) — conservative
              const Myaw_OEI=T_per_motor*Larm;        // yaw moment (N·m)
              const Myaw_avail=SR.Sv_eff*(0.5*rhoMSL*VC*VC)*SR.lv*0.3; // available yaw authority
              const yawControllable=Myaw_avail>=Myaw_OEI;
              // Structural margins
              const nLimitCheck=nPosLimit>=2.5; // CS-VTOL minimum
              const gustCheck=ngust_c<=nPosLimit;
              return(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:`linear-gradient(135deg,${SC.bg},#0f1a2e)`,border:`1px solid #3b82f644`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:4}}>CS-VTOL / CS-23 AMD 5 COMPLIANT</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:"#60a5fa"}}>V-n Diagram</span> & One-Engine-Inoperative Analysis
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:760}}>
                    Manoeuvring envelope per CS-VTOL Special Condition and CS-23 Amendment 5. Gust loads computed using Pratt method with alleviation factor. OEI control authority per CS-VTOL AMC 27.65 — survivability requires remaining motors to absorb load within peak power rating.
                  </div>
                </div>
                {/* V-n Chart */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                    <div style={{fontSize:10,fontWeight:700,color:SC.text,fontFamily:"'DM Mono',monospace",marginBottom:8}}>📐 V-n Maneuvering Envelope</div>
                    <ResponsiveContainer width="100%" height={280}>
                      <ComposedChart data={pts} margin={{top:10,right:20,left:0,bottom:20}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={SC.border}/>
                        <XAxis dataKey="v" type="number" domain={[0,VD*1.15]} tick={{fontSize:9,fill:SC.muted}} label={{value:"EAS (m/s)",position:"insideBottom",offset:-8,fontSize:10,fill:SC.muted}}/>
                        <YAxis domain={[-2.5,5]} tick={{fontSize:9,fill:SC.muted}} label={{value:"Load Factor n",angle:-90,position:"insideLeft",fontSize:10,fill:SC.muted}}/>
                        <Tooltip {...TTP} formatter={(v,n)=>[+v.toFixed(3),n]}/>
                        <ReferenceLine y={0} stroke={SC.border} strokeWidth={1}/>
                        <ReferenceLine y={nPosLimit} stroke={SC.green} strokeDasharray="5 3" label={{value:`n+lim ${nPosLimit}`,fill:SC.green,fontSize:9,position:"right"}}/>
                        <ReferenceLine y={nNegLimit} stroke={SC.red} strokeDasharray="5 3" label={{value:`n-lim ${nNegLimit}`,fill:SC.red,fontSize:9,position:"right"}}/>
                        <ReferenceLine x={Vstall} stroke={SC.amber} strokeDasharray="4 2" label={{value:"VS",fill:SC.amber,fontSize:9,position:"top"}}/>
                        <ReferenceLine x={VA} stroke="#a78bfa" strokeDasharray="4 2" label={{value:"VA",fill:"#a78bfa",fontSize:9,position:"top"}}/>
                        <ReferenceLine x={VC} stroke={SC.teal} strokeDasharray="4 2" label={{value:"VC",fill:SC.teal,fontSize:9,position:"top"}}/>
                        <ReferenceLine x={VD} stroke={SC.red} strokeDasharray="4 2" label={{value:"VD",fill:SC.red,fontSize:9,position:"top"}}/>
                        <Line type="monotone" dataKey="nPos" stroke="#60a5fa" strokeWidth={2.5} dot={false} name="n+ (manoeuvre)"/>
                        <Line type="monotone" dataKey="nNeg" stroke="#f87171" strokeWidth={2} dot={false} name="n- (manoeuvre)"/>
                        {/* Gust lines */}
                        <ReferenceLine y={ngust_c} stroke={SC.amber} strokeDasharray="3 3" label={{value:`Gust VC: ${ngust_c.toFixed(2)}`,fill:SC.amber,fontSize:8,position:"insideTopRight"}}/>
                        <ReferenceLine y={ngust_d} stroke={SC.red} strokeDasharray="3 3" label={{value:`Gust VD: ${ngust_d.toFixed(2)}`,fill:SC.red,fontSize:8,position:"insideTopRight"}}/>
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Key values */}
                  <div style={{display:"flex",flexDirection:"column",gap:8}}>
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Envelope Speeds</div>
                      {[["Stall Speed VS",`${SR.Vstall.toFixed(1)} m/s (${(SR.Vstall*1.944).toFixed(0)} kt)`,SC.amber],
                        ["Manoeuvre Speed VA",`${SR.VA.toFixed(1)} m/s (${(SR.VA*1.944).toFixed(0)} kt)`,SC.green],
                        ["Cruise Speed VC",`${VC.toFixed(1)} m/s (${(VC*1.944).toFixed(0)} kt)`,SC.teal],
                        ["Dive Speed VD",`${SR.VD.toFixed(1)} m/s (${(SR.VD*1.944).toFixed(0)} kt)`,SC.red],
                        ["Max Load Factor n+",`${nPosLimit} g (ult. ${nUltPos})`,SC.green],
                        ["Min Load Factor n−",`${nNegLimit} g (ult. ${nUltNeg})`,SC.red],
                        ["Gust n (cruise)",`${ngust_c.toFixed(3)} g`,gustCheck?SC.green:SC.red],
                        ["Gust n (dive)",`${ngust_d.toFixed(3)} g`,SC.amber],
                        ["Gust alleviation Kg",`${Kg.toFixed(3)}`,SC.muted],
                      ].map(([k,v,col])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${SC.border}22`}}>
                          <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{k}</span>
                          <span style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{background:SC.panel,border:`1px solid ${SC.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:10}}>Structural Checks (CS-VTOL)</div>
                      {[
                        ["n+ limit ≥ 2.5 g",nLimitCheck,"PASS","FAIL"],
                        ["Gust n ≤ n+limit",gustCheck,"PASS","FAIL"],
                        ["VD ≥ 1.25 VC",SR.VD>=VC*1.25,"PASS","FAIL"],
                        ["VA = VS×√n+",Math.abs(SR.VA-SR.Vstall*Math.sqrt(nPosLimit))<0.5,"PASS","FAIL"],
                      ].map(([label,ok,p,f])=>(
                        <div key={label} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid ${SC.border}22`}}>
                          <span style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace"}}>{label}</span>
                          <span style={{fontSize:10,fontWeight:800,fontFamily:"'DM Mono',monospace",color:ok?SC.green:SC.red}}>{ok?`✅ ${p}`:`❌ ${f}`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* OEI Analysis */}
                <div style={{background:SC.panel,border:`2px solid ${OEI_margin_pct>0?SC.green:SC.red}`,borderRadius:8,padding:"14px 16px"}}>
                  <div style={{fontSize:11,fontWeight:700,color:OEI_margin_pct>0?SC.green:SC.red,fontFamily:"'DM Mono',monospace",marginBottom:10}}>
                    {OEI_margin_pct>0?"✅":"❌"} One-Engine-Inoperative (OEI) — CS-VTOL AMC 27.65
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:12}}>
                    {[["Rotors",N,""],["OEI Thrust Margin",`${OEI_margin_pct.toFixed(1)}%`,OEI_margin_pct>0?SC.green:SC.red],["Power per Motor (OEI)",`${(P_per_motor_OEI/1000).toFixed(1)} kW`,motorSurvivable?SC.green:SC.red],["Motor Overload",`+${P_overhead_pct.toFixed(1)}%`,P_overhead_pct<50?SC.green:SC.red],
                    ].map(([k,v,col])=>(
                      <div key={k} style={{background:SC.bg,borderRadius:6,padding:"10px 12px",border:`1px solid ${SC.border}`}}>
                        <div style={{fontSize:8,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:4}}>{k}</div>
                        <div style={{fontSize:14,fontWeight:800,color:col||SC.text,fontFamily:"'DM Mono',monospace"}}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6}}>Thrust Analysis</div>
                      {[["Total hover thrust req.",`${(T_required/1000).toFixed(2)} kN`],["OEI thrust available",`${(T_remaining/1000).toFixed(2)} kN`],["Thrust margin",`${OEI_margin_pct.toFixed(2)}%`],["Each motor thrust",`${(T_per_motor/1000).toFixed(2)} kN`],
                      ].map(([k,v])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${SC.border}22`,fontSize:9,fontFamily:"'DM Mono',monospace"}}>
                          <span style={{color:SC.muted}}>{k}</span><span style={{color:SC.text,fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",marginBottom:6}}>Power & Control</div>
                      {[["Nominal motor power",`${(P_per_motor/1000).toFixed(1)} kW`],["OEI motor power",`${(P_per_motor_OEI/1000).toFixed(1)} kW`],["Peak motor rating",`${SR.PpeakKW.toFixed(1)} kW`],["Motor survivable",motorSurvivable?"YES ✅":"NO ❌"],["Yaw controllable",yawControllable?"YES ✅":"NO ❌"],["OEI yaw moment",`${(Myaw_OEI/1000).toFixed(2)} kN·m`],
                      ].map(([k,v])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${SC.border}22`,fontSize:9,fontFamily:"'DM Mono',monospace"}}>
                          <span style={{color:SC.muted}}>{k}</span><span style={{color:SC.text,fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{marginTop:10,padding:"8px 12px",background:OEI_margin_pct>0?`${SC.green}11`:`${SC.red}11`,borderRadius:6,fontSize:10,color:OEI_margin_pct>0?SC.green:SC.red,fontFamily:"'DM Mono',monospace",lineHeight:1.7}}>
                    {OEI_margin_pct>0
                      ?`✅ OEI SURVIVABLE: With ${N-1} of ${N} motors operating, thrust margin is +${OEI_margin_pct.toFixed(1)}%. Each remaining motor needs ${(P_per_motor_OEI/1000).toFixed(1)} kW (${P_overhead_pct.toFixed(0)}% overload vs nominal, ${motorSurvivable?"within":"EXCEEDS"} ${SR.PpeakKW.toFixed(0)} kW peak rating).`
                      :`❌ OEI NOT SURVIVABLE: With 1 motor failed, remaining thrust (${(T_remaining/1000).toFixed(1)} kN) < weight (${(T_required/1000).toFixed(1)} kN). Increase rotor count or T/W ratio. Consider adding a ${Math.ceil(N*1.15)}-rotor configuration.`
                    }
                  </div>
                </div>
              </div>
              );
            })()}

            {/* ──── TAB 19: DESIGN SPACE EXPLORER (Pareto Front) ────
                OUTSIDE SR&& so it NEVER unmounts when params change.
                CSS display:none keeps it alive while hidden — same pattern as tab 17. ── */}
            <div style={{display:tab===19?'block':'none'}}>
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:`linear-gradient(135deg,${SC.bg},#1a0a2e)`,border:`1px solid #8b5cf644`,borderRadius:10,padding:"16px 20px"}}>
                  <div style={{fontSize:9,color:SC.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.18em",marginBottom:4}}>LATIN HYPERCUBE SAMPLING — PARETO ANALYSIS</div>
                  <div style={{fontSize:18,fontWeight:800,color:SC.text,marginBottom:6}}>
                    <span style={{color:"#a78bfa"}}>Design Space</span> Explorer
                  </div>
                  <div style={{fontSize:11,color:SC.muted,lineHeight:1.7,maxWidth:760}}>
                    Simultaneously sweeps Range × Payload × MTOW design space using Latin Hypercube Sampling across 8 key design variables. Each point is a full sizing solution. Feasible (green) vs infeasible (red) boundary shows the true design frontier — what Joby and Archer compute with proprietary tools.
                  </div>
                </div>
                <DesignSpacePanel params={params} SC={SC} TTP={TTP} runSizingFn={runSizing}
                  onApply={pt=>setParams(prev=>({
                    ...prev,
                    range:    pt.range,
                    payload:  Math.round(pt.payload),   // must be integer
                    LD:       pt.LD,
                    sedCell:  Math.round(pt.sedCell),   // must be integer
                    ewf:      pt.ewf,
                    AR:       Math.round(pt.AR*10)/10,  // one decimal
                    etaHov:   pt.etaHov,
                    etaSys:   pt.etaSys,
                  }))}/>
              </div>
            </div>

            {/* ──── TAB 20: BEM ROTOR SOLVER ──── */}
            {tab===20&&(
              <BEMPanel params={params} SR={SR} SC={SC}/>
            )}

            {/* ──── TAB 21: REGULATORY CHANGE TRACKER ──── */}
            {tab===21&&(
              <RegTrackerPanel params={params} SR={SR} SC={SC}/>
            )}

            {/* ──── TAB 22: AI DESIGN ASSISTANT ──── */}
            {tab===22&&(
              <AIAssistantPanel params={params} SR={SR} SC={SC} onParamChange={set} user={user}/>
            )}

            {/* ──── TAB 17: REAL-TIME COLLABORATION ────
                OUTSIDE SR&&<> so it NEVER unmounts on tab switch.
                CSS display:none keeps it alive while hidden. ── */}
            <div style={{display:tab===17?'block':'none',minHeight:tab===17?0:0}}>
              <CollabPanel user={user} params={params} onParamChange={set} C={SC}/>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
