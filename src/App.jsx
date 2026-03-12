import { useState, useMemo, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, RadarChart, Radar,
  ComposedChart,
  PolarGrid, PolarAngleAxis, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine, Cell, PieChart, Pie
} from "recharts";

/* ═══════════════════════════════════════════════════════════════════════
   PHYSICS ENGINE — exact port of eVTOL_Full_Analysis_v2.m
   ═══════════════════════════════════════════════════════════════════════ */
function runSizing(p) {
  const g0=9.81,rhoMSL=1.225,T0=288.15,L=0.0065,Rgas=287,GAM=1.4,mu0=1.47e-5;
  const Tcr=T0-L*p.cruiseAlt;
  const rhoCr=rhoMSL*Math.pow(Tcr/T0,(-g0/(-L*Rgas))-1);
  const muCr=mu0*Math.pow(Tcr/T0,0.75);
  const aCr=Math.sqrt(GAM*Rgas*Tcr);
  const RoC=p.rateOfClimb,clAng=p.climbAngle;
  const Vcl=RoC/Math.sin(clAng*Math.PI/180);
  const LDcl=p.LD*(1-0.13);
  const desAng=Math.atan(1/p.LD)*180/Math.PI;
  const Vdc=-RoC/Math.sin(-desAng*Math.PI/180);
  const Vres=0.7*p.vCruise;
  const hvtol=p.hoverHeight;
  const ClimbR=(p.cruiseAlt-hvtol)/Math.tan(clAng*Math.PI/180);
  const DescR=(p.cruiseAlt-hvtol)/Math.tan(desAng*Math.PI/180);

  /* Round 1 */
  let MTOW1=2177,Wempty1,Wbat1;
  for(let i=0;i<5000;i++){
    Wempty1=p.ewf*MTOW1;
    const bf=(g0*p.range*1000)/(p.LD*p.etaSys*p.sedCell*3600);
    Wbat1=bf*MTOW1;
    const mn=p.payload+Wempty1+Wbat1;
    if(Math.abs(mn-MTOW1)<1e-6){MTOW1=mn;break;}
    MTOW1=mn;
    if(MTOW1>5700)break;
  }

  const CruiseRange=p.range*1000-ClimbR-DescR-p.reserveRange*1000;

  /* Round 2 — coupled MTOW+Energy */
  let MTOW=MTOW1;
  let Phov,Pcl,Pcr,Pdc,Pres,tto,tcl,tcr,tdc,tld,tres;
  let Eto,Ecl,Ecr,Edc,Eld,Eres,Etot,Wempty,Wbat;
  const mtowH=[MTOW1],energyH=[];
  for(let o=0;o<50;o++){
    const W=MTOW*g0;
    const DL=W/(Math.PI*Math.pow(p.propDiam/2,2)*p.nPropHover);
    Phov=(W/p.etaHov)*Math.sqrt(DL/(2*rhoMSL))/1000;
    Pcl=(W/p.etaSys)*(RoC+Vcl/LDcl)/1000;
    Pcr=(W/p.etaSys)*(p.vCruise/p.LD)/1000;
    Pdc=(W/p.etaSys)*(-RoC+Vdc/LDcl)/1000;
    Pres=(W/p.etaSys)*(Vres/p.LD)/1000;
    tto=hvtol/0.5; tcl=ClimbR/Vcl; tcr=Math.max(0,CruiseRange/p.vCruise);
    tdc=DescR/Vdc; tld=hvtol/0.5; tres=p.reserveRange*1000/Vres;
    Eto=Phov*tto/3600; Ecl=Pcl*tcl/3600; Ecr=Pcr*tcr/3600;
    Edc=Math.abs(Pdc)*tdc/3600; Eld=Phov*tld/3600; Eres=Pres*tres/3600;
    Etot=Eto+Ecl+Ecr+Edc+Eld+Eres;
    Wempty=p.ewf*MTOW;
    // Original MATLAB formula: W_battery = E_total*1000*(1+SoCmin)/(SED_cell*eta_bat)
    Wbat=Etot*1000*(1+p.socMin)/(p.sedCell*p.etaBat);
    const mn=p.payload+Wempty+Wbat;
    energyH.push(+Etot.toFixed(3)); mtowH.push(+mn.toFixed(2));
    if(Math.abs(mn-MTOW)<1e-6){MTOW=mn;break;}
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

  /* Airfoil selection */
  const AF=[
    {name:"NACA 23015",tc:0.150,CLmax:1.60,CLd:0.60,CDmin:0.0060,CM:-0.010,ReM:6.0},
    {name:"NACA 2412", tc:0.120,CLmax:1.50,CLd:0.55,CDmin:0.0058,CM:-0.050,ReM:6.0},
    {name:"NACA 4415", tc:0.150,CLmax:1.65,CLd:0.65,CDmin:0.0065,CM:-0.095,ReM:5.0},
    {name:"Clark Y",   tc:0.117,CLmax:1.47,CLd:0.58,CDmin:0.0059,CM:-0.080,ReM:5.0},
    {name:"NACA 63-215",tc:0.150,CLmax:1.55,CLd:0.60,CDmin:0.0042,CM:-0.040,ReM:7.0},
    {name:"NACA 63A-412",tc:0.120,CLmax:1.52,CLd:0.58,CDmin:0.0040,CM:-0.045,ReM:8.0},
    {name:"NASA GA(W)-1",tc:0.170,CLmax:1.80,CLd:0.70,CDmin:0.0070,CM:-0.120,ReM:4.0},
    {name:"NACA 63-415",tc:0.150,CLmax:1.60,CLd:0.62,CDmin:0.0044,CM:-0.065,ReM:7.0},
  ];
  const ReM_=Re_/1e6,maxCD_=Math.max(...AF.map(a=>a.CDmin));
  const afScored=AF.map(a=>({...a,
    score:0.30*(1-Math.min(Math.abs(a.ReM-ReM_)/ReM_,1))
         +0.20*(1-Math.min(Math.abs(a.tc-p.tc)/p.tc,1))
         +0.20*(1-Math.min(Math.abs(a.CLd-p.clDesign)/p.clDesign,1))
         +0.20*(1-a.CDmin/maxCD_)
         +0.10*(1-Math.min(Math.abs(a.CM)/0.12,1))
  }));
  const selAF=afScored.reduce((a,b)=>b.score>a.score?b:a);

  /* Drag (Raymer) */
  const Sww=2*Swing*(1+0.25*p.tc*(1+p.taper*0.25));
  const fL=p.fusLen,fD=p.fusDiam;
  const lambda_f=fL/fD;  // fineness ratio
  const Swf=Math.PI*fD*fL*Math.pow(1-2/lambda_f,2/3)*(1+1/lambda_f**2);  // Raymer Eq 12.31
  const Swhs=2*Swing*0.18,Swvs=2*Swing*0.12,Swn=p.nPropHover*Math.PI*0.2*0.35;
  const Refus=rhoCr*p.vCruise*fL/muCr;
  const Cfw=0.455/Math.log10(Re_)**2.58/(1+0.144*Mach**2)**0.65;
  const Cff=0.455/Math.log10(Refus)**2.58/(1+0.144*Mach**2)**0.65;
  const FFw=(1+0.6/0.3*p.tc+100*p.tc**4)*1.05;
  const FFf=1+60/(fL/fD)**3+(fL/fD)/400;
  const CD0w=Cfw*FFw*Sww/Swing,CD0f=Cff*FFf*Swf/Swing;
  const CD0h=Cfw*1.05*Swhs/Swing,CD0v=Cfw*1.05*Swvs/Swing;
  const CD0n=Cfw*1.30*Swn/Swing,CD0g=0.015,CD0m=0.002;
  const CD0tot=CD0w+CD0f+CD0h+CD0v+CD0n+CD0g+CD0m;
  const CDi=p.clDesign**2/(Math.PI*p.AR*p.eOsw);
  const CDtot=CD0tot+CDi,LDact=p.clDesign/CDtot;

  /* Stability */
  const xCGfus=fL*0.42,xCGwing=fL*0.2589+Xac,xCGbat=fL*0.38,xCGpay=fL*0.40;  // wing LE = 25.9% fL
  const Wfusc=Wempty*0.35,Wwingc=Wempty*0.18,Wmotc=Wempty*0.22,Wavc=Wempty*0.04,Wothc=Wempty*0.21;
  const xCGempty=(Wfusc*xCGfus+Wwingc*xCGwing+Wmotc*xCGfus+Wavc*0.8+Wothc*xCGfus)/Wempty;
  const xCGtotal=(Wempty*xCGempty+Wbat*xCGbat+p.payload*xCGpay)/MTOW;
  const xACwing=fL*0.2589+Xac,lh=fL-xACwing,Sh=Swing*0.18;  // wing LE scales with fL
  const CLaW=2*Math.PI*(1+0.77*p.tc),dw=2*CLaW/(Math.PI*p.AR);
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
  // When resolved into pitch (vertical) and yaw (lateral) moments:
  //   Pitch contribution: F_pitch = L·cosΓ, moment arm projects as lh·cosΓ → ∝ cos²(Γ)
  //   Yaw  contribution: F_yaw  = L·sinΓ, moment arm projects as lv·sinΓ → ∝ sin²(Γ)
  //
  // So the correct effectiveness equations are:
  //   Sh_eff = S_panel × cos²(Γ)   (NOT cosΓ)
  //   Sv_eff = S_panel × sin²(Γ)   (NOT sinΓ)
  //
  // Panel sizing: must satisfy BOTH constraints simultaneously:
  //   S_panel ≥ Sh_req / cos²(Γ)   [pitch governs]
  //   S_panel ≥ Sv_req / sin²(Γ)   [yaw governs]
  //   → S_panel = max of the two (size to the harder constraint at chosen Γ)
  //
  // Minimum-area optimal angle: set Sh_req/cos²Γ = Sv_req/sin²Γ
  //   → tan²(Γ) = Sv_req/Sh_req  → Γ_opt = arctan(√(Sv_req/Sh_req))  (NOT arctan(Sv/Sh))
  // ─────────────────────────────────────────────────────────────────────
  const cos2=Math.cos(vtGamma)**2, sin2=Math.sin(vtGamma)**2;

  // Optimal dihedral — minimises total panel area
  const vtGamma_opt_deg=Math.atan(Math.sqrt(Sv_req/Sh_req))*180/Math.PI;

  // Required panel area at the chosen Γ (size to harder constraint)
  const Svt_panel_pitch=Sh_req/cos2;   // area needed to satisfy pitch at this Γ
  const Svt_panel_yaw  =Sv_req/sin2;   // area needed to satisfy yaw   at this Γ
  const Svt_panel=Math.max(Svt_panel_pitch, Svt_panel_yaw); // governing constraint
  const Svt_total=2*Svt_panel;          // both panels combined

  // Actual effectiveness delivered (always 100% for governing constraint by construction)
  const Sh_eff=Svt_panel*cos2;   // pitch moment arm equivalent area
  const Sv_eff=Svt_panel*sin2;   // yaw  moment arm equivalent area

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
  const Ttot=MTOW*g0,Trotor=Ttot/p.nPropHover,Protor_W=Phov*1000/p.nPropHover;
  const Adisk=Trotor**3/(2*rhoMSL*(Protor_W*p.etaHov)**2);
  const Rrotor=Math.sqrt(Adisk/Math.PI),Drotor=2*Rrotor;
  const DLrotor=Trotor/Adisk,PLrotor=Trotor/(Protor_W/1000);
  const TipSpd=Math.sqrt(2*Protor_W*p.etaHov/(rhoMSL*Adisk)),TipMach=TipSpd/aCr;
  const RPM=TipSpd/Rrotor*60/(2*Math.PI);
  const sigma=0.10,Nbld=3,ChordBl=sigma*Math.PI*Rrotor/Nbld,BladeAR=Rrotor/ChordBl;
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
  const Vstall=Math.sqrt(2*WL/(rhoCr*selAF.CLmax)),VA=Vstall*Math.sqrt(3.5),VD=p.vCruise*1.25;
  const vnData=Array.from({length:60},(_,i)=>{
    const v=VD*1.1*i/59;
    return {v:+v.toFixed(1),nPos:+Math.min(0.5*rhoCr*v**2*p.clDesign/WL,3.5).toFixed(3),
      nNeg:+Math.max(-0.5*rhoCr*v**2*0.8*p.clDesign/WL,-1.5).toFixed(3)};
  });

  /* Range-payload */
  const Efl_design=Etot-Eto-Eld;
  const rpData=Array.from({length:60},(_,i)=>{
    const pay=(MTOW-Wempty-50)*i/59,Wavail=MTOW-Wempty-pay;
    if(Wavail<=0)return{payload:+pay.toFixed(0),range:0};
    const Eavail=Wavail*p.sedCell*p.etaBat/(1000*(1+p.socMin));  // usable fraction = 1/(1+SoCmin)
    return{payload:+pay.toFixed(0),range:+Math.max(0,((Eavail-Eto-Eld)/Efl_design)*p.range).toFixed(1)};
  });

  /* Aerodynamic polar */
  const polarData=Array.from({length:81},(_,i)=>{
    const alpha=-4+i*0.25,CL=0.40+2*Math.PI*(1+0.77*selAF.tc)*alpha*Math.PI/180;
    const CD=selAF.CDmin+(CL-p.clDesign)**2/(Math.PI*p.AR*p.eOsw);
    return{alpha:+alpha.toFixed(2),CL:+CL.toFixed(4),CD:+CD.toFixed(5),LD:+(CL/CD).toFixed(2)};
  });

  /* Time-power-velocity-SoC profiles */
  const tPhases=[0,tto,tto+tcl,tto+tcl+tcr,tto+tcl+tcr+tdc,tto+tcl+tcr+tdc+tld,tto+tcl+tcr+tdc+tld+tres];
  const Tend=tPhases[6],phPow=[Phov,Pcl,Pcr,Math.abs(Pdc),Phov,Pres];
  const phV=[0.5,Vcl,p.vCruise,Vdc,0.5,Vres];
  const Ecum_ph=[0,Eto,Eto+Ecl,Eto+Ecl+Ecr,Eto+Ecl+Ecr+Edc,Eto+Ecl+Ecr+Edc+Eld,Etot];
  const N=200,powerSteps=[],socSteps=[],velSteps=[],energySteps=[];
  for(let i=0;i<=N;i++){
    const t=Tend*i/N;
    let ph=5; for(let j=0;j<6;j++)if(t>=tPhases[j]&&t<tPhases[j+1]){ph=j;break;}
    const Ec=Ecum_ph[ph]+phPow[ph]*((t-tPhases[ph])/3600);
    const socFloor=p.socMin/(1+p.socMin);  // true floor = SoCmin/(1+SoCmin)
    const soc=Math.max(socFloor,(1-Ec/PackkWh))*100;
    powerSteps.push({t:+t.toFixed(0),P:+phPow[ph].toFixed(1),ph:["TO","Climb","Cruise","Desc","Land","Res"][ph]});
    socSteps.push({t:+t.toFixed(0),SoC:+soc.toFixed(2)});
    velSteps.push({t:+t.toFixed(0),V:+phV[ph].toFixed(1)});
    energySteps.push({t:+t.toFixed(0),E:+Ec.toFixed(3),P:+phPow[ph].toFixed(1),ph:["TO","Climb","Cruise","Desc","Land","Res"][ph]});
  }

  /* Convergence chart data */
  const convData=mtowH.map((m,i)=>({iter:i,MTOW:+m.toFixed(1),Energy:energyH[i]||null}));

  /* Weight breakdown (Roskam) */
  const ewFracs=[0.18,0.28,0.05,0.04,0.04,0.22,0.04,0.02,0.08,0.05];
  const ewNames=["Wing Struct","Fuselage","Tail Surf","Booms","LG","Propulsion","Avionics","ECS","Elec Sys","Furnish"];
  const weightBreak=ewNames.map((n,i)=>({name:n,val:+(ewFracs[i]*Wempty).toFixed(1)}));

  /* Drag pie */
  const dragComp=[
    {name:"Wing",val:+CD0w.toFixed(5)},{name:"Fuselage",val:+CD0f.toFixed(5)},
    {name:"H-Stab",val:+CD0h.toFixed(5)},{name:"V-Stab",val:+CD0v.toFixed(5)},
    {name:"Nacelles",val:+CD0n.toFixed(5)},{name:"Land.Gear",val:+CD0g.toFixed(5)},{name:"Misc",val:+CD0m.toFixed(5)},
  ];

  /* Feasibility */
  const checks=[
    {label:"MTOW < 5700 kg",ok:MTOW<5700,val:`${MTOW.toFixed(1)} kg`},
    {label:"Pack ≥ Mission E",ok:PackkWh>=Etot,val:`${PackkWh.toFixed(2)} ≥ ${Etot.toFixed(2)} kWh`},
    {label:"SM 5–25% MAC",ok:SM>=0.05&&SM<=0.25,val:`${(SM*100).toFixed(1)}%`},
    {label:"Tip Mach < 0.70",ok:TipMach<0.70,val:`M${TipMach.toFixed(3)}`},
    {label:"Battery Frac < 55%",ok:Wbat/MTOW<0.55,val:`${(Wbat/MTOW*100).toFixed(1)}%`},
    {label:"Final SoC ≥ SoCmin",ok:(1-Etot/PackkWh)>=(p.socMin/(1+p.socMin))-0.01,val:`${((1-Etot/PackkWh)*100).toFixed(1)}% (floor ${(p.socMin/(1+p.socMin)*100).toFixed(1)}%)`},
    {label:"Actual L/D > 10",ok:LDact>10,val:LDact.toFixed(2)},
    {label:"V-tail pitch auth.",ok:pitch_ratio>=1.0,val:`${(pitch_ratio*100).toFixed(0)}%`},
    {label:"V-tail yaw auth.",ok:yaw_ratio>=1.0,val:`${(yaw_ratio*100).toFixed(0)}%`},
    {label:"Mach < 0.45",ok:Mach<0.45,val:`M${Mach.toFixed(3)}`},
    {label:"Tail/Wing area 25–50%",ok:(Svt_total/Swing)>=0.20&&(Svt_total/Swing)<=0.55,val:`${(Svt_total/Swing*100).toFixed(1)}%`},
    {label:"Fus/Span 0.50–0.72",ok:(fL/bWing)>=0.50&&(fL/bWing)<=0.72,val:`${(fL/bWing).toFixed(3)}`},
  ];

  return {
    MTOW:+MTOW.toFixed(2),MTOW1:+MTOW1.toFixed(2),Wempty:+Wempty.toFixed(2),Wbat:+Wbat.toFixed(2),
    Phov:+Phov.toFixed(2),Pcl:+Pcl.toFixed(2),Pcr:+Pcr.toFixed(2),Pdc:+Math.abs(Pdc).toFixed(2),Pres:+Pres.toFixed(2),
    tto:+tto.toFixed(0),tcl:+tcl.toFixed(0),tcr:+tcr.toFixed(0),tdc:+tdc.toFixed(0),tld:+tld.toFixed(0),tres:+tres.toFixed(0),
    Tend:+Tend.toFixed(0),
    Eto:+Eto.toFixed(3),Ecl:+Ecl.toFixed(3),Ecr:+Ecr.toFixed(3),Edc:+Edc.toFixed(3),Eld:+Eld.toFixed(3),Eres:+Eres.toFixed(3),Etot:+Etot.toFixed(3),
    Swing:+Swing.toFixed(2),WL:+WL.toFixed(1),bWing:+bWing.toFixed(2),Cr_:+Cr_.toFixed(3),Ct_:+Ct_.toFixed(3),
    MAC:+MAC.toFixed(3),Ymac:+Ymac.toFixed(3),Xac:+Xac.toFixed(3),sweep:+sweep.toFixed(2),Re_:+Re_.toFixed(0),Mach:+Mach.toFixed(4),
    selAF,afScored,LDact:+LDact.toFixed(2),CD0tot:+CD0tot.toFixed(5),CDi:+CDi.toFixed(5),CDtot:+CDtot.toFixed(5),dragComp,
    SM:+SM.toFixed(4),xCGtotal:+xCGtotal.toFixed(3),xNP:+xNP.toFixed(3),xCGempty:+xCGempty.toFixed(3),xACwing:+xACwing.toFixed(3),
    Drotor:+Drotor.toFixed(3),DLrotor:+DLrotor.toFixed(1),PLrotor:+PLrotor.toFixed(1),
    TipSpd:+TipSpd.toFixed(1),TipMach:+TipMach.toFixed(4),RPM:+RPM.toFixed(0),
    ChordBl:+ChordBl.toFixed(4),BladeAR:+BladeAR.toFixed(2),Nbld,PmotKW:+PmotKW.toFixed(2),
    PpeakKW:+PpeakKW.toFixed(2),Torque:+Torque.toFixed(1),MotMass:+MotMass.toFixed(2),
    SEDpack:+SEDpack.toFixed(1),Nseries,Npar,Ncells,PackV:+PackV.toFixed(0),PackAh:+PackAh.toFixed(1),
    PackkWh:+PackkWh.toFixed(3),CrateHov:+CrateHov.toFixed(2),CrateCr:+CrateCr.toFixed(2),Pheat:+Pheat.toFixed(1),
    Vstall:+Vstall.toFixed(2),VA:+VA.toFixed(2),VD:+VD.toFixed(2),
    vnData,rpData,polarData,powerSteps,socSteps,velSteps,energySteps,convData,weightBreak,dragComp,tPhases,
    checks,feasible:checks.every(c=>c.ok),
    vtGamma_opt:+vtGamma_opt_deg.toFixed(1),Svt_total:+Svt_total.toFixed(3),Svt_panel:+Svt_panel.toFixed(3),governs_pitch:Svt_panel_pitch>=Svt_panel_yaw,ruddervator_combined_auth:+ruddervator_combined_auth.toFixed(3),delta_yaw_rv_deg:+delta_yaw_rv_deg.toFixed(2),
    Sh_req:+Sh_req.toFixed(3),Sv_req:+Sv_req.toFixed(3),Sh_eff:+Sh_eff.toFixed(3),Sv_eff:+Sv_eff.toFixed(3),
    pitch_ratio:+pitch_ratio.toFixed(3),yaw_ratio:+yaw_ratio.toFixed(3),
    bvt_panel:+bvt_panel.toFixed(3),Cr_vt:+Cr_vt.toFixed(3),Ct_vt:+Ct_vt.toFixed(3),MAC_vt:+MAC_vt.toFixed(3),
    sweep_vt:+sweep_vt.toFixed(2),Srv:+Srv.toFixed(3),Wvt_total:+Wvt_total.toFixed(1),
    CD0vt:+CD0vt.toFixed(6),SM_vt:+SM_vt.toFixed(4),delta_rv_deg:+delta_rv_deg.toFixed(2),
    lv:+lv.toFixed(3),
    fusSpanRatio:+(fL/bWing).toFixed(3),
    tailWingRatio:+(Svt_total/Swing).toFixed(4),
  };
}


/* ═══════════════════════════════════════════════════════════════════════
   OPENVSP ANGELSCRIPT GENERATOR  v4
   Mirrors the exact confirmed-working API pattern exactly.
   Run in OpenVSP: File -> Run Script -> Execute
   ═══════════════════════════════════════════════════════════════════════ */
function generateVSPScript(p, R) {
  // Safe formatter — NaN/undefined always become 0, never embed "NaN"
  const f = (v, d=4) => { const n=Number(v); return (isFinite(n)?n:0).toFixed(d); };

  // Sizing outputs with fallbacks
  const fL      = f(p.fusLen    || 6.5,   2);
  const fDn     = +(p.fusDiam   || 1.65);
  const bWing   = f(R.bWing     || 12.67, 2);
  const Swing   = f(R.Swing     || 17.83, 2);
  const Cr_     = f(R.Cr_       || 1.941, 2);
  const Ct_     = f(R.Ct_       || 0.874, 2);
  const sw      = f(R.sweep     || 9.57,  1);   // corrected LE sweep
  const xACw    = +(R.xACwing   || 2.518);  // corrected (scales with fL)
  const Cr_n    = +(R.Cr_       || 1.941);
  const lv_n    = +(R.lv        || 3.315);
  const MACvt   = +(R.MAC_vt    || 1.752);
  const bvt     = f(R.bvt_panel || 3.766, 2);  // corrected
  const Cr_vt   = f(R.Cr_vt     || 2.152, 2);  // corrected
  const Ct_vt   = f(R.Ct_vt     || 0.861, 2);  // corrected
  const sw_vt   = f(R.sweep_vt  || 34.44, 1);  // corrected LE sweep
  const vtG     = f(p.vtGamma   || 45,    1);
  const Drot    = f(R.Drotor    || 3.000, 2);
  const MTOW    = f(R.MTOW      || 2720.9,1);
  const Wempty  = f(R.Wempty    || 1414,  1);
  const Wbat    = f(R.Wbat      || 851,   1);
  const xCG     = f(R.xCGtotal  || 2.225, 3);
  const xNP_    = f(R.xNP       || 2.556, 3);
  const SM_     = f((+(R.SM||0.2246))*100, 2);

  // Fuselage cross-section widths & heights (same "Width"/"Height" parm names as working script)
  const w1 = f(fDn*0.88, 2),  h1 = f(fDn*0.82, 2);   // XSec 1 forward
  const w2 = f(fDn*1.06, 2),  h2 = f(fDn,       2);   // XSec 2 max section
  // (only 2 XSecs needed — matches working template)

  // Wing placement: root LE from nose
  const xWingLE = f(xACw - 0.25*Cr_n,          2);
  const zWing   = f(fDn * 0.42,                 2);    // high-wing

  // V-tail: root LE so AC lands at xACwing + lv
  const xVtLE   = f((xACw + lv_n) - 0.25*MACvt, 2);
  const zVtRoot = f(fDn * 0.10,                  2);

  // Rotors: evenly spaced across semi-span, same pattern as working script
  const nSide = Math.floor((+(p.nPropHover)||6) / 2);
  const bHalf = (+(R.bWing)||12.67) / 2;
  const rotX  = f(xACw + Cr_n*0.20, 2);
  const rotZ  = f(fDn*0.42 + (+(R.Drotor)||3)*0.18, 2);
  const yVals = Array.from({length:nSide}, (_,i) => f(bHalf*(i+0.5)/nSide, 2));

  return `// ═══════════════════════════════════════════════════════════════════
// Trail 1 eVTOL  —  Generated by eVTOL Sizer v2.0
// Wright State University  |  Dr. Darryl K. Ahner
// ───────────────────────────────────────────────────────────────────
// HOW TO RUN  (OpenVSP 3.28+, incl. 3.48.2):
//   File -> Run Script -> select this .vspscript -> Execute
// ───────────────────────────────────────────────────────────────────
// MTOW=${MTOW} kg   Empty=${Wempty} kg   Battery=${Wbat} kg
// Wing: b=${bWing} m  S=${Swing} m2  Cr=${Cr_} m  Ct=${Ct_} m
// V-tail: Gamma=${vtG} deg  bPanel=${bvt} m
// Rotors: ${p.nPropHover||6}x  D=${Drot} m
// CG=${xCG} m  NP=${xNP_} m  SM=${SM_}% MAC
// ═══════════════════════════════════════════════════════════════════

void main()
{
    ClearVSPModel();
    Update();
    Print( "Building Trail-1 eVTOL..." );

    // ── Fuselage ──────────────────────────────────────────────────
    string fus = AddGeom( "FUSELAGE", "" );
    SetParmVal( fus, "Length", "Design", ${fL} );

    string surf = GetXSecSurf( fus, 0 );

    string xsec1 = GetXSec( surf, 1 );
    SetParmVal( xsec1, "Width",  "XSecCurve", ${w1} );
    SetParmVal( xsec1, "Height", "XSecCurve", ${h1} );

    string xsec2 = GetXSec( surf, 2 );
    SetParmVal( xsec2, "Width",  "XSecCurve", ${w2} );
    SetParmVal( xsec2, "Height", "XSecCurve", ${h2} );

    Update();

    // ── Main Wing (high-wing, XZ symmetry) ────────────────────────
    //    S=${Swing} m2  b=${bWing} m  LE at x=${xWingLE} m  z=${zWing} m
    string wing = AddGeom( "WING", fus );
    SetParmVal( wing, "Sym_Planar_Flag", "Sym",     2.0 );
    SetParmVal( wing, "X_Rel_Location",  "XForm",   ${xWingLE} );
    SetParmVal( wing, "Z_Rel_Location",  "XForm",   ${zWing} );
    SetParmVal( wing, "TotalSpan",       "WingGeom", ${bWing} );
    SetParmVal( wing, "TotalArea",       "WingGeom", ${Swing} );
    SetParmVal( wing, "Root_Chord",      "XSec_1",   ${Cr_} );
    SetParmVal( wing, "Tip_Chord",       "XSec_1",   ${Ct_} );
    SetParmVal( wing, "Sweep",           "XSec_1",   ${sw} );
    SetParmVal( wing, "Dihedral",        "XSec_1",   2.0 );
    Update();

    // ── V-Tail (XZ symmetry, dihedral = Gamma) ────────────────────
    //    bPanel=${bvt} m  Gamma=${vtG} deg  LE at x=${xVtLE} m
    string vtail = AddGeom( "WING", fus );
    SetParmVal( vtail, "Sym_Planar_Flag", "Sym",     2.0 );
    SetParmVal( vtail, "X_Rel_Location",  "XForm",   ${xVtLE} );
    SetParmVal( vtail, "Z_Rel_Location",  "XForm",   ${zVtRoot} );
    SetParmVal( vtail, "TotalSpan",       "WingGeom", ${bvt} );
    SetParmVal( vtail, "Root_Chord",      "XSec_1",   ${Cr_vt} );
    SetParmVal( vtail, "Tip_Chord",       "XSec_1",   ${Ct_vt} );
    SetParmVal( vtail, "Sweep",           "XSec_1",   ${sw_vt} );
    SetParmVal( vtail, "Dihedral",        "XSec_1",   ${vtG} );
    Update();

    // ── Hover Rotors (${p.nPropHover||6} total, D=${Drot} m) ──────────────────────
    //    Y_Rel_Rotation=-90 => disk horizontal => thrust +Z (up)
    array<double> y( ${nSide} );
${yVals.map((v,i)=>`    y[${i}] = ${v};`).join('\n')}

    for ( int i = 0; i < ${nSide}; i++ )
    {
        string r1 = AddGeom( "PROP", fus );
        SetParmVal( r1, "X_Rel_Location", "XForm",  ${rotX} );
        SetParmVal( r1, "Y_Rel_Location", "XForm",  y[i] );
        SetParmVal( r1, "Z_Rel_Location", "XForm",  ${rotZ} );
        SetParmVal( r1, "Y_Rel_Rotation", "XForm", -90.0 );
        SetParmVal( r1, "Diameter",       "Design",  ${Drot} );

        string r2 = AddGeom( "PROP", fus );
        SetParmVal( r2, "X_Rel_Location", "XForm",  ${rotX} );
        SetParmVal( r2, "Y_Rel_Location", "XForm", -y[i] );
        SetParmVal( r2, "Z_Rel_Location", "XForm",  ${rotZ} );
        SetParmVal( r2, "Y_Rel_Rotation", "XForm", -90.0 );
        SetParmVal( r2, "Diameter",       "Design",  ${Drot} );
    }
    Update();

    WriteVSPFile( "Trail1_evtol.vsp3", SET_ALL );
    Print( "MTOW=${MTOW} kg  b=${bWing} m  CG=${xCG} m  SM=${SM_}%" );
    Print( "Model Created" );
}`;
}


/* ═══════════════════════════════════════════════════════════════════════
   PDF REPORT GENERATOR
   Builds a complete HTML document with KaTeX-rendered LaTeX equations.
   User clicks "Download PDF" → new window opens → browser print dialog
   → "Save as PDF". Native browser PDF engine = perfect quality.
   ═══════════════════════════════════════════════════════════════════════ */
function generateReport(p, R) {
  const n = (v, d=3) => (typeof v==="number" && isFinite(v)) ? v.toFixed(d) : "—";
  const now = new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"});
  const feasBadge = R.feasible
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
    `<table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;

  const check = (ok, label, val) =>
    `<tr class="${ok?"ok":"fail"}"><td>${ok?"✓":"✗"}</td><td>${label}</td><td>${val}</td></tr>`;

  // ── COVER PAGE ───────────────────────────────────────────────────────
  const cover = `
  <div class="cover-page">
    <div class="cover-logo">AEROSPACE DESIGN SUITE</div>
    <div class="cover-title">eVTOL Aircraft<br>Sizing Report</div>
    <div class="cover-sub">Trail 1 Design — Parametric Sizing Analysis</div>
    <div class="cover-line"></div>
    <table class="cover-meta">
      <tr><td>Institution</td><td>Wright State University</td></tr>
      <tr><td>Advisor</td><td>Dr. Darryl K. Ahner</td></tr>
      <tr><td>Framework</td><td>MATLAB-MBSE Integrated Sizing Framework</td></tr>
      <tr><td>Algorithm</td><td>eVTOL_Full_Analysis_v2.m — JavaScript Port</td></tr>
      <tr><td>Report Generated</td><td>${now}</td></tr>
      <tr><td>Design Status</td><td>${feasBadge}</td></tr>
    </table>
    <div class="cover-kpi-grid">
      <div class="kpi"><div class="kpi-val">${n(R.MTOW,1)} kg</div><div class="kpi-lbl">MTOW</div></div>
      <div class="kpi"><div class="kpi-val">${n(R.Etot,2)} kWh</div><div class="kpi-lbl">Total Energy</div></div>
      <div class="kpi"><div class="kpi-val">${n(R.Phov,1)} kW</div><div class="kpi-lbl">Hover Power</div></div>
      <div class="kpi"><div class="kpi-val">${n(R.bWing,2)} m</div><div class="kpi-lbl">Wing Span</div></div>
      <div class="kpi"><div class="kpi-val">${n(R.SM*100,1)}%</div><div class="kpi-lbl">Static Margin</div></div>
      <div class="kpi"><div class="kpi-val">${n(R.LDact,2)}</div><div class="kpi-lbl">Actual L/D</div></div>
    </div>
  </div>`;

  // ── 1. DESIGN INPUTS ─────────────────────────────────────────────────
  const s1 = sec("inputs","1. Design Inputs & Mission Requirements",`
  <p>The following input parameters define the baseline design for the Trail 1 eVTOL configuration. All sizing calculations are derived directly from these values.</p>
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Payload","m<sub>pay</sub>",p.payload,"kg"),
    row("Design Range","R",p.range,"km"),
    row("Cruise Speed","V<sub>cr</sub>",p.vCruise,"m/s ("+n(p.vCruise*3.6,1)+" km/h)"),
    row("Cruise Altitude","h<sub>cr</sub>",p.cruiseAlt,"m"),
    row("Reserve Range","R<sub>res</sub>",p.reserveRange,"km"),
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
  ${eq("T_{cr} = T_0 - L_{lapse} \\cdot h_{cr} = 288.15 - 0.0065 \\times "+p.cruiseAlt+" = "+n(288.15-0.0065*p.cruiseAlt,2)+"\\text{ K}",
    "Temperature at cruise altitude")}
  ${eq("\\rho_{cr} = \\rho_{SL}\\left(\\frac{T_{cr}}{T_0}\\right)^{\\left(\\frac{g_0}{L_{lapse}\\,R_{air}}\\right)-1} = "+n(R.MTOW ? 1.225*Math.pow((288.15-0.0065*p.cruiseAlt)/288.15, (-9.81/(-0.0065*287))-1) : 1.112,4)+"\\text{ kg/m}^3",
    "Density at cruise altitude (ISA troposphere)")}
  ${eq("a_{cr} = \\sqrt{\\gamma R_{air} T_{cr}} = \\sqrt{1.4 \\times 287 \\times "+(288.15-0.0065*p.cruiseAlt).toFixed(2)+"} = "+n(Math.sqrt(1.4*287*(288.15-0.0065*p.cruiseAlt)),2)+"\\text{ m/s}",
    "Speed of sound at cruise altitude")}
  ${eq("M = \\frac{V_{cr}}{a_{cr}} = \\frac{"+p.vCruise+"}{"+n(Math.sqrt(1.4*287*(288.15-0.0065*p.cruiseAlt)),2)+"} = "+n(R.Mach,4),
    "Cruise Mach number")}
  `);

  // ── 3. WEIGHT SIZING ─────────────────────────────────────────────────
  const s3 = sec("weight","3. Weight & Energy Sizing (Iterative)",`
  <p>The MTOW is found by simultaneously converging the weight and energy fractions using a nested iterative scheme. The battery mass fraction is:</p>
  ${eq("f_{bat} = \\frac{g_0 \\cdot R}{(L/D)\\,\\eta_{sys}\\,\\text{SED}_{cell}\\times 3600}","Battery mass fraction (range-energy method)")}
  ${eq("W_{bat} = \\frac{E_{total}\\times 1000\\,(1+\\text{SoC}_{min})}{\\text{SED}_{cell}\\,\\eta_{bat}}","Battery mass from total mission energy")}
  ${eq("\\text{MTOW} = m_{pay} + f_{EW}\\cdot\\text{MTOW} + W_{bat}","Weight closure equation (solved iteratively)")}
  ${table(["Quantity","Symbol","Value","Unit"],[
    row("MTOW (initial)","MTOW<sub>1</sub>",n(R.MTOW1,1),"kg"),
    row("MTOW (converged)","MTOW",n(R.MTOW,1),"kg"),
    row("Empty Weight","W<sub>e</sub>",n(R.Wempty,1),"kg"),
    row("Battery Mass","W<sub>bat</sub>",n(R.Wbat,1),"kg"),
    row("Payload","m<sub>pay</sub>",p.payload,"kg"),
    row("Battery Mass Fraction","W<sub>bat</sub>/MTOW",n(R.Wbat/R.MTOW*100,1),"%"),
  ])}
  `);

  // ── 4. MISSION ENERGY ────────────────────────────────────────────────
  const s4 = sec("energy","4. Mission Energy Breakdown",`
  <p>The mission is divided into six phases: Takeoff (hover), Climb, Cruise, Descent, Landing (hover), and Reserve.</p>
  ${eq("E_{total} = E_{TO}+E_{cl}+E_{cr}+E_{dc}+E_{ld}+E_{res} = "+n(R.Etot,3)+"\\text{ kWh}","Total mission energy")}
  ${eq("P_{hov} = \\frac{W\\,g_0}{\\eta_{hov}}\\sqrt{\\frac{W\\,g_0}{2\\,\\rho_{SL}\\,N_{rot}\\,A_{disk}}} = "+n(R.Phov,2)+"\\text{ kW}","Hover power (actuator disk theory)")}
  ${eq("P_{cr} = \\frac{W\\,g_0\\,V_{cr}}{\\eta_{sys}\\,(L/D)} = "+n(R.Pcr,2)+"\\text{ kW}","Cruise power")}
  ${table(["Phase","Power (kW)","Time (s)","Energy (kWh)"],[
    row("Takeoff (Hover)","P<sub>hov</sub> = "+n(R.Phov,2),n(R.tto,0),n(R.Eto,3)),
    row("Climb","P<sub>cl</sub> = "+n(R.Pcl,2),n(R.tcl,0),n(R.Ecl,3)),
    row("Cruise","P<sub>cr</sub> = "+n(R.Pcr,2),n(R.tcr,0),n(R.Ecr,3)),
    row("Descent","P<sub>dc</sub> = "+n(R.Pdc,2),n(R.tdc,0),n(R.Edc,3)),
    row("Landing (Hover)","P<sub>hov</sub> = "+n(R.Phov,2),n(R.tld,0),n(R.Eld,3)),
    row("Reserve","P<sub>res</sub> = "+n(R.Pres,2),n(R.tres,0),n(R.Eres,3)),
    row("<strong>Total</strong>","","<strong>"+n(R.Tend,0)+" s</strong>","<strong>"+n(R.Etot,3)+"</strong>"),
  ])}
  `);

  // ── 5. WING AERODYNAMICS ─────────────────────────────────────────────
  const s5 = sec("wing","5. Wing Design & Aerodynamics",`
  <p>Wing area is sized to provide the required lift at cruise using the design lift coefficient C<sub>L,des</sub> = ${p.clDesign}.</p>
  ${eq("S_w = \\frac{2\\,L_{req}}{\\rho_{cr}\\,V_{cr}^2\\,C_{L,des}} = \\frac{2\\times"+n(R.MTOW*9.81,1)+"}{"+n(1.225*Math.pow((288.15-0.0065*p.cruiseAlt)/288.15,(-9.81/(-0.0065*287))-1),4)+"\\times"+p.vCruise+"^2\\times"+p.clDesign+"} = "+n(R.Swing,2)+"\\text{ m}^2","Wing reference area")}
  ${eq("b_w = \\sqrt{AR\\cdot S_w} = \\sqrt{"+p.AR+"\\times"+n(R.Swing,2)+"} = "+n(R.bWing,2)+"\\text{ m}","Wing span")}
  ${eq("C_r = \\frac{2S_w}{b_w(1+\\lambda)} = "+n(R.Cr_,3)+"\\text{ m}, \\quad C_t = \\lambda\\,C_r = "+n(R.Ct_,3)+"\\text{ m}","Root and tip chord (taper λ = "+p.taper+")")}
  ${eq("\\bar{c} = \\frac{2}{3}C_r\\frac{1+\\lambda+\\lambda^2}{1+\\lambda} = "+n(R.MAC,3)+"\\text{ m}","Mean aerodynamic chord (MAC)")}
  ${eq("\\Lambda_{LE} = \\arctan\\!\\left(\\frac{C_r - C_t}{b_w/2}\\right) = \\arctan\\!\\left(\\frac{"+n(R.Cr_,3)+"-"+n(R.Ct_,3)+"}{"+n(R.bWing/2,3)+"}\\right) = "+n(R.sweep,2)+"^\\circ","Leading edge sweep (semi-span denominator)")}
  ${eq("C_{D_0,total} = "+n(R.CD0tot,5)+", \\quad C_{D_i} = \\frac{C_{L,des}^2}{\\pi\\,AR\\,e} = "+n(R.CDi,5),"Parasitic and induced drag coefficients")}
  ${eq("(L/D)_{actual} = \\frac{C_{L,des}}{C_{D_0}+C_{D_i}} = "+n(R.LDact,2),"Actual cruise lift-to-drag ratio")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Wing Area","S<sub>w</sub>",n(R.Swing,2),"m²"),
    row("Wing Span","b<sub>w</sub>",n(R.bWing,3),"m"),
    row("Root Chord","C<sub>r</sub>",n(R.Cr_,3),"m"),
    row("Tip Chord","C<sub>t</sub>",n(R.Ct_,3),"m"),
    row("MAC","c̄",n(R.MAC,3),"m"),
    row("y<sub>MAC</sub>","ȳ<sub>MAC</sub>",n(R.Ymac,3),"m"),
    row("LE Sweep","Λ<sub>LE</sub>",n(R.sweep,2),"°"),
    row("Wing Loading","W/S",n(R.WL,1),"N/m²"),
    row("Re (MAC)","Re",n(R.Re_,0),""),
    row("Selected Airfoil","—",R.selAF?.name||"—",""),
    row("Actual L/D","(L/D)<sub>act</sub>",n(R.LDact,2),""),
    row("C<sub>D0</sub> total","C<sub>D0</sub>",n(R.CD0tot,5),""),
    row("C<sub>Di</sub>","C<sub>Di</sub>",n(R.CDi,5),""),
  ])}
  `);

  // ── 6. PROPULSION ────────────────────────────────────────────────────
  const s6 = sec("prop","6. Hover Propulsion Sizing",`
  <p>Rotor disk area is sized from actuator disk theory to satisfy the hover power budget with the given figure of merit η<sub>hov</sub> = ${p.etaHov}.</p>
  ${eq("T_{rotor} = \\frac{W\\,g_0}{N_{rot}} = \\frac{"+n(R.MTOW,1)+"\\times 9.81}{"+p.nPropHover+"} = "+n(R.MTOW*9.81/p.nPropHover,1)+"\\text{ N}","Thrust per rotor")}
  ${eq("A_{disk} = \\frac{T_{rotor}^3}{2\\,\\rho_{SL}\\,(P_{rotor}\\,\\eta_{hov})^2}","Disk area from actuator disk momentum theory")}
  ${eq("D_{rotor} = 2\\sqrt{A_{disk}/\\pi} = "+n(R.Drotor,3)+"\\text{ m}","Rotor diameter")}
  ${eq("\\Omega_{tip} = \\sqrt{\\frac{2P_{rotor}\\eta_{hov}}{\\rho_{SL}\\,A_{disk}}}, \\quad \\text{RPM} = \\frac{60\\,\\Omega_{tip}}{2\\pi R} = "+n(R.RPM,0),"Tip speed and rotational speed")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Hover Power (total)","P<sub>hov</sub>",n(R.Phov,2),"kW"),
    row("Power per Rotor","P<sub>rotor</sub>",n(R.Phov/p.nPropHover,2),"kW"),
    row("Rotor Diameter","D<sub>rot</sub>",n(R.Drotor,3),"m"),
    row("Disk Loading","DL",n(R.DLrotor,1),"N/m²"),
    row("Power Loading","PL",n(R.PLrotor,1),"N/W"),
    row("Tip Speed","Ω<sub>tip</sub>",n(R.TipSpd,1),"m/s"),
    row("Tip Mach","M<sub>tip</sub>",n(R.TipMach,4),""),
    row("RPM","n",n(R.RPM,0),"rpm"),
    row("No. of Blades","N<sub>bl</sub>",R.Nbld,""),
    row("Blade Chord","c<sub>bl</sub>",n(R.ChordBl,4),"m"),
    row("Motor Power","P<sub>mot</sub>",n(R.PmotKW,2),"kW"),
    row("Peak Power","P<sub>peak</sub>",n(R.PpeakKW,2),"kW"),
  ])}
  `);

  // ── 7. BATTERY ───────────────────────────────────────────────────────
  const s7 = sec("battery","7. Battery System Sizing",`
  ${eq("W_{bat} = \\frac{E_{total}\\times 1000\\,(1+\\text{SoC}_{min})}{\\text{SED}_{cell}\\,\\eta_{bat}} = \\frac{"+n(R.Etot,3)+"\\times 1000\\times(1+"+p.socMin+")}{"+p.sedCell+"\\times"+p.etaBat+"} = "+n(R.Wbat,1)+"\\text{ kg}","Battery mass")}
  ${eq("\\text{SED}_{pack} = \\frac{E_{total}}{W_{bat}} = "+n(R.SEDpack,1)+"\\text{ Wh/kg}","Pack-level specific energy density")}
  ${eq("N_{series} = \\text{round}\\!\\left(\\frac{V_{pack}}{V_{cell}}\\right) = \\text{round}\\!\\left(\\frac{800}{3.6}\\right) = "+R.Nseries,"Series cell count for 800V pack")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Battery Mass","W<sub>bat</sub>",n(R.Wbat,1),"kg"),
    row("Total Energy","E<sub>total</sub>",n(R.Etot,3),"kWh"),
    row("Pack SED","SED<sub>pack</sub>",n(R.SEDpack,1),"Wh/kg"),
    row("Pack Voltage","V<sub>pack</sub>",n(R.PackV,0),"V"),
    row("Pack Capacity","Q<sub>pack</sub>",n(R.PackAh,1),"Ah"),
    row("Series Cells","N<sub>s</sub>",R.Nseries,""),
    row("Parallel Strings","N<sub>p</sub>",R.Npar,""),
    row("Total Cells","N<sub>cells</sub>",R.Ncells,""),
    row("C-rate (Hover)","C<sub>hov</sub>",n(R.CrateHov,2),"C"),
    row("C-rate (Cruise)","C<sub>cr</sub>",n(R.CrateCr,2),"C"),
  ])}
  `);

  // ── 8. STABILITY ─────────────────────────────────────────────────────
  const xACwing = n(+(p.fusLen*0.2589 + (R.Cr_-(R.MAC-0.25*R.MAC))),3);
  const s8 = sec("stability","8. Longitudinal Stability",`
  <p>The static margin (SM) measures stability: positive SM indicates the neutral point (NP) is aft of the centre of gravity (CG).</p>
  ${eq("x_{CG,total} = \\frac{W_e\\,x_{CG,e}+W_{bat}\\,x_{CG,bat}+m_{pay}\\,x_{CG,pay}}{\\text{MTOW}} = "+n(R.xCGtotal,3)+"\\text{ m from nose}","Total centre of gravity")}
  ${eq("x_{NP} = x_{AC,wing} + \\frac{S_h}{S_w}\\,\\eta_h\\,(1-\\varepsilon_\\alpha)\\,l_h = "+n(R.SM_vt !== undefined ? R.xNP : R.xNP,3)+"\\text{ m from nose}","Neutral point (stick-fixed)")}
  ${eq("SM = \\frac{x_{NP}-x_{CG}}{\\bar{c}} = \\frac{"+n(R.xNP,3)+"-"+n(R.xCGtotal,3)+"}{"+n(R.MAC,3)+"} = "+n(R.SM*100,1)+"\\%\\;\\text{MAC}","Static margin")}
  ${table(["Quantity","Symbol","Value","Unit"],[
    row("Wing AC from nose","x<sub>AC,w</sub>",xACwing,"m"),
    row("Total CG from nose","x<sub>CG</sub>",n(R.xCGtotal,3),"m"),
    row("Neutral Point from nose","x<sub>NP</sub>",n(R.xNP,3),"m"),
    row("Static Margin","SM",n(R.SM*100,2),"%  MAC"),
    row("MAC","c̄",n(R.MAC,3),"m"),
  ])}
  `);

  // ── 9. V-TAIL ────────────────────────────────────────────────────────
  const s9 = sec("vtail","9. V-Tail Sizing (Ruscheweyh / Raymer)",`
  <p>The V-tail replaces both the horizontal and vertical stabilisers. Each panel is inclined at dihedral angle Γ = ${p.vtGamma}° from horizontal.</p>
  ${eq("S_{h,req} = \\frac{C_h\\,S_w\\,\\bar{c}}{l_v} = \\frac{"+p.vtCh+"\\times"+n(R.Swing,2)+"\\times"+n(R.MAC,3)+"}{"+n(R.lv,3)+"} = "+n(R.Sh_req,3)+"\\text{ m}^2","Required horizontal tail area")}
  ${eq("S_{v,req} = \\frac{C_v\\,S_w\\,b_w}{l_v} = \\frac{"+p.vtCv+"\\times"+n(R.Swing,2)+"\\times"+n(R.bWing,2)+"}{"+n(R.lv,3)+"} = "+n(R.Sv_req,3)+"\\text{ m}^2","Required vertical tail area")}
  ${eq("S_{panel} = \\max\\!\\left(\\frac{S_{h,req}}{\\cos^2\\Gamma},\\,\\frac{S_{v,req}}{\\sin^2\\Gamma}\\right) = "+n(R.Svt_panel,3)+"\\text{ m}^2","V-tail panel area (governing constraint)")}
  ${eq("\\Gamma_{opt} = \\arctan\\!\\sqrt{\\frac{S_{v,req}}{S_{h,req}}} = "+n(R.vtGamma_opt,1)+"^\\circ","Optimal dihedral angle for minimum panel area")}
  ${eq("b_{vt} = \\sqrt{AR_{vt}\\cdot S_{panel}} = "+n(R.bvt_panel,3)+"\\text{ m}, \\quad C_{r,vt} = "+n(R.Cr_vt,3)+"\\text{ m}, \\quad C_{t,vt} = "+n(R.Ct_vt,3)+"\\text{ m}","V-tail panel geometry")}
  ${table(["Parameter","Symbol","Value","Unit"],[
    row("Tail moment arm","l<sub>v</sub>",n(R.lv,3),"m"),
    row("Req. H-tail area","S<sub>h,req</sub>",n(R.Sh_req,3),"m²"),
    row("Req. V-tail area","S<sub>v,req</sub>",n(R.Sv_req,3),"m²"),
    row("Panel area","S<sub>panel</sub>",n(R.Svt_panel,3),"m²"),
    row("Total V-tail area","S<sub>vt,total</sub>",n(R.Svt_total,3),"m²"),
    row("Optimal Γ","Γ<sub>opt</sub>",n(R.vtGamma_opt,1),"°"),
    row("Chosen Γ","Γ",p.vtGamma,"°"),
    row("Panel span","b<sub>vt</sub>",n(R.bvt_panel,3),"m"),
    row("Root chord","C<sub>r,vt</sub>",n(R.Cr_vt,3),"m"),
    row("Tip chord","C<sub>t,vt</sub>",n(R.Ct_vt,3),"m"),
    row("LE sweep","Λ<sub>LE,vt</sub>",n(R.sweep_vt,2),"°"),
    row("Pitch authority","—",n(R.pitch_ratio*100,1),"%"),
    row("Yaw authority","—",n(R.yaw_ratio*100,1),"%"),
  ])}
  `);

  // ── 10. FEASIBILITY ──────────────────────────────────────────────────
  const s10 = sec("feasibility","10. Feasibility Checks",`
  <table class="check-table"><thead><tr><th>Pass</th><th>Criterion</th><th>Value</th></tr></thead><tbody>
    ${(R.checks||[]).map(c=>check(c.ok,c.label,c.val)).join("")}
  </tbody></table>
  `);

  // ── FULL HTML PAGE ───────────────────────────────────────────────────
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>eVTOL Sizing Report — Trail 1</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body,{
    delimiters:[
      {left:'$$',right:'$$',display:true},
      {left:'$',right:'$',display:false}
    ]
  });renderKatex();"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;font-size:10pt;color:#1a1a2e;background:#fff;line-height:1.5}
  .cover-page{min-height:100vh;display:flex;flex-direction:column;justify-content:center;
    align-items:center;padding:60px 80px;page-break-after:always;
    background:linear-gradient(160deg,#0d1b2a 0%,#1b2a4a 60%,#243b55 100%)}
  .cover-logo{font-size:8pt;color:#7fa3c8;letter-spacing:0.35em;font-family:monospace;margin-bottom:28px}
  .cover-title{font-size:38pt;font-weight:900;color:#fff;text-align:center;line-height:1.1;margin-bottom:10px}
  .cover-sub{font-size:12pt;color:#94a3b8;margin-bottom:30px;text-align:center}
  .cover-line{width:120px;height:3px;background:linear-gradient(90deg,#f59e0b,#3b82f6);margin-bottom:30px;border-radius:2px}
  .cover-meta{border-collapse:collapse;color:#c8d6e5;font-size:10pt;margin-bottom:36px;width:480px}
  .cover-meta td{padding:7px 16px;border-bottom:1px solid #2a3a5c}
  .cover-meta td:first-child{color:#94a3b8;font-size:8.5pt;text-transform:uppercase;letter-spacing:0.05em;width:160px}
  .cover-kpi-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;width:480px}
  .kpi{background:#ffffff0f;border:1px solid #ffffff18;border-radius:8px;padding:14px;text-align:center}
  .kpi-val{font-size:18pt;font-weight:800;color:#f59e0b;font-family:monospace}
  .kpi-lbl{font-size:7.5pt;color:#7fa3c8;text-transform:uppercase;letter-spacing:0.1em;margin-top:3px}
  .badge{display:inline-block;padding:3px 10px;border-radius:4px;font-size:8.5pt;font-weight:700;letter-spacing:0.05em}
  .badge.green{background:#16a34a22;color:#16a34a;border:1px solid #16a34a44}
  .badge.amber{background:#d9770622;color:#d97706;border:1px solid #d9770644}
  section{padding:28px 56px;page-break-inside:avoid}
  section:not(.cover-page){border-bottom:1px solid #e5e7eb}
  h2{font-size:14pt;font-weight:800;color:#0f172a;margin-bottom:14px;padding-bottom:6px;
    border-bottom:2px solid #3b82f6;display:flex;align-items:center;gap:8px}
  h2::before{content:attr(data-num);display:none}
  p{color:#374151;margin-bottom:10px;font-size:9.5pt}
  .eq-block{background:#f8faff;border-left:3px solid #3b82f6;padding:10px 18px;margin:10px 0 6px;border-radius:0 6px 6px 0}
  .eq-note{font-size:8pt;color:#64748b;margin-top:4px;font-style:italic}
  .data-table{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:9pt}
  .data-table th{background:#0f172a;color:#e2e8f0;padding:7px 10px;text-align:left;font-size:8.5pt;letter-spacing:0.03em}
  .data-table td{padding:6px 10px;border-bottom:1px solid #e5e7eb}
  .data-table tr:nth-child(even) td{background:#f8faff}
  .td-label{color:#374151;font-weight:600;white-space:nowrap}
  .td-formula{color:#1e3a5f;font-style:italic;min-width:140px}
  .td-value{color:#0f172a;font-weight:700;font-family:monospace;text-align:right;white-space:nowrap}
  .td-unit{color:#64748b;font-size:8.5pt;white-space:nowrap;padding-left:6px}
  .check-table{width:100%;border-collapse:collapse;margin:10px 0;font-size:9.5pt}
  .check-table th{background:#0f172a;color:#e2e8f0;padding:7px 12px;text-align:left;font-size:8.5pt}
  .check-table td{padding:7px 12px;border-bottom:1px solid #e5e7eb}
  .check-table tr.ok td:first-child{color:#16a34a;font-weight:800;font-size:11pt}
  .check-table tr.fail td:first-child{color:#dc2626;font-weight:800;font-size:11pt}
  .check-table tr.ok{background:#f0fdf4}
  .check-table tr.fail{background:#fef2f2}
  @media print{
    @page{margin:18mm 18mm 18mm 18mm;size:A4}
    .cover-page{min-height:0;page-break-after:always}
    section{page-break-inside:avoid}
    h2{page-break-after:avoid}
  }
</style>
</head>
<body>
${cover}
${s1}${s2}${s3}${s4}${s5}${s6}${s7}${s8}${s9}${s10}
<section style="background:#0f172a;color:#94a3b8;text-align:center;padding:24px;font-size:8pt">
  Generated by eVTOL Sizer v2.0 — Wright State University — ${now}<br>
  All calculations based on Raymer (Aircraft Design: A Conceptual Approach) and MATLAB eVTOL_Full_Analysis_v2.m
</section>
<script>
function renderKatex(){
  document.querySelectorAll('.katex-eq').forEach(el=>{
    try{katex.render(el.dataset.latex,el,{displayMode:true,throwOnError:false});}catch(e){}
  });
  document.querySelectorAll('.katex-inline').forEach(el=>{
    try{katex.render(el.dataset.latex,el,{displayMode:false,throwOnError:false});}catch(e){}
  });
}
window.addEventListener('load',()=>{setTimeout(()=>window.print(),1200);});
</script>
</body>
</html>`;
}

/* ═══════════════════════════════════
   THEME & CONSTANTS
   ═══════════════════════════════════ */
const PHC=["#ff6b35","#ffd23f","#06d6a0","#118ab2","#8338ec","#6c757d"];
const C={bg:"#07090f",panel:"#0d1117",border:"#1c2333",amber:"#f59e0b",teal:"#14b8a6",
  blue:"#3b82f6",red:"#ef4444",green:"#22c55e",dim:"#4b5563",text:"#e2e8f0",muted:"#64748b"};

/* ═══════════════════════════════════
   REUSABLE COMPONENTS
   ═══════════════════════════════════ */
function Slider({label,unit,value,min,max,step,onChange,note}){
  const pct=((value-min)/(max-min))*100;
  return(
    <div style={{marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,alignItems:"center"}}>
        <span style={{fontSize:10,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.04em"}}>{label}</span>
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <input type="number" value={value} step={step} min={min} max={max}
            onChange={e=>{const v=parseFloat(e.target.value);if(!isNaN(v))onChange(Math.max(min,Math.min(max,v)));}}
            style={{width:62,background:"#0d1117",border:`1px solid ${C.border}`,borderRadius:3,color:C.amber,
              fontSize:11,textAlign:"right",padding:"2px 5px",fontFamily:"'DM Mono',monospace",outline:"none"}}/>
          <span style={{fontSize:9,color:C.dim,minWidth:26,fontFamily:"'DM Mono',monospace"}}>{unit}</span>
        </div>
      </div>
      <div style={{position:"relative",height:3,background:"#1c2333",borderRadius:2}}>
        <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${pct}%`,
          background:`linear-gradient(90deg,${C.teal},${C.amber})`,borderRadius:2,transition:"width 0.1s"}}/>
        <input type="range" value={value} min={min} max={max} step={step}
          onChange={e=>onChange(parseFloat(e.target.value))}
          style={{position:"absolute",top:-7,left:0,width:"100%",opacity:0,cursor:"pointer",height:17}}/>
      </div>
      {note&&<div style={{fontSize:8,color:C.dim,marginTop:2,fontFamily:"'DM Mono',monospace"}}>{note}</div>}
    </div>
  );
}

function KPI({label,value,unit,sub,color}){
  const col=color||C.amber;
  return(
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:6,padding:"9px 12px",borderLeft:`2px solid ${col}`}}>
      <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"'DM Mono',monospace",marginBottom:3}}>{label}</div>
      <div style={{fontSize:18,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",lineHeight:1.1}}>
        {typeof value==="number"?value.toLocaleString():value}
        <span style={{fontSize:9,color:C.muted,marginLeft:3,fontWeight:400}}>{unit}</span>
      </div>
      {sub&&<div style={{fontSize:8,color:C.dim,marginTop:2,fontFamily:"'DM Mono',monospace"}}>{sub}</div>}
    </div>
  );
}

function Panel({title,children,h}){
  return(
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px",height:h||"auto"}}>
      <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:"'DM Mono',monospace",
        marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>{title}</div>
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
        <span style={{fontSize:9,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:"'DM Mono',monospace"}}>{title}</span>
        <span style={{marginLeft:"auto",color:C.dim,fontSize:10}}>{open?"▾":"▸"}</span>
      </button>
      {open&&<div style={{paddingTop:4}}>{children}</div>}
    </div>
  );
}

const TABS=["Overview","Mission","Wing & Aero","Propulsion","Battery","Performance","Stability","V-Tail","Convergence","OpenVSP"];
const TABI=["⬛","🛫","✈️","🔧","🔋","📈","⚖️","🦋","🔄","🛩️"];
const TTP={contentStyle:{background:"#131c2e",border:"1px solid #2a3a5c",borderRadius:6,fontSize:12,color:"#e2e8f0",boxShadow:"0 4px 20px rgba(0,0,0,0.8)"},labelStyle:{color:"#94a3b8",fontSize:12,fontWeight:600},itemStyle:{color:"#e2e8f0",fontSize:12}};

/* ═══════════════════════════════════
   APP
   ═══════════════════════════════════ */
export default function App(){
  const[tab,setTab]=useState(0);
  const[p,setP]=useState({
    // ── Mission ──────────────────────────────────────────────────────────
    payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
    // ── Aerodynamics (calibrated vs Joby S4 / Archer Midnight / NASA NDARC) ──
    LD:14,AR:9,eOsw:0.85,clDesign:0.55,taper:0.45,tc:0.15,
    // ── Propulsion ───────────────────────────────────────────────────────
    nPropHover:6,propDiam:3.0,
    etaHov:0.70,          // FOM 0.70 — achievable with optimised eVTOL hover rotor (was 0.63)
    etaSys:0.80,          // drivetrain η — modern PMSM motors + inverter ~93%×93% (was 0.765)
    rateOfClimb:5.08,climbAngle:5,
    // ── Battery (2025 state-of-art; Joby claims ~300 Wh/kg cell-level) ──
    sedCell:300,etaBat:0.90,socMin:0.2,
    // ── Weights (composite airframe; Joby EWF=0.43, Archer~0.45, conservative 0.50) ──
    ewf:0.50,
    // ── Geometry (Lf/b target 0.55–0.70; fL=7.2 gives 0.564 with 12.77 m span) ──
    fusLen:7.2,fusDiam:1.65,
    // ── V-tail (NASA NDARC UAM values for FBW lift+cruise eVTOL) ──────────
    vtGamma:45,
    vtCh:0.28,            // Ch reduced from 0.40: FBW+DEP reduces required pitch authority
    vtCv:0.032,           // Cv reduced from 0.05: same rationale; gives tail/wing ~37%
    vtAR:2.5,
  });
  const set=useCallback(k=>v=>setP(prev=>({...prev,[k]:v})),[]);
  const R=useMemo(()=>{try{return runSizing(p);}catch{return null;}},[p]);
  const stCol=!R?C.red:R.feasible?C.green:C.amber;
  const stTxt=!R?"ERROR":R.feasible?"FEASIBLE":"CHECK DESIGN";

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100vh",background:C.bg,color:C.text,
      fontFamily:"'Barlow',system-ui,sans-serif",overflow:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Barlow:wght@400;600;700;800&display=swap');
        html,body{background:#07090f;color:#e2e8f0;margin:0;padding:0}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:#07090f}
        ::-webkit-scrollbar-thumb{background:#1c2333;border-radius:3px}
        input[type=range]{-webkit-appearance:none;appearance:none}
        input[type=number]{-moz-appearance:textfield;background:#0d1117;color:#f59e0b}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none}
        .recharts-tooltip-wrapper .recharts-default-tooltip{background:#131c2e !important;border:1px solid #2a3a5c !important;border-radius:6px !important;box-shadow:0 4px 20px rgba(0,0,0,0.8) !important;padding:8px 12px !important}
        .recharts-tooltip-wrapper .recharts-tooltip-label{color:#94a3b8 !important;font-size:12px !important;font-weight:600 !important;margin-bottom:4px !important;display:block}
        .recharts-tooltip-wrapper .recharts-tooltip-item{color:#e2e8f0 !important;font-size:12px !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-name{color:#94a3b8 !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-value{color:#f59e0b !important;font-weight:700 !important}
        .recharts-tooltip-wrapper .recharts-tooltip-item-separator{color:#4b5563 !important}
        .recharts-legend-item-text{color:#94a3b8 !important;font-size:11px !important}
        span,div,td,th{color:inherit}
      `}</style>

      {/* HEADER */}
      <div style={{display:"flex",alignItems:"center",padding:"8px 18px",background:C.panel,
        borderBottom:`1px solid ${C.border}`,gap:14,flexShrink:0,flexWrap:"wrap"}}>
        <div>
          <div style={{fontSize:7,color:C.muted,letterSpacing:"0.2em",fontFamily:"'DM Mono',monospace"}}>AEROSPACE DESIGN SUITE</div>
          <div style={{fontSize:19,fontWeight:800,letterSpacing:"-0.03em",lineHeight:1}}>
            <span style={{color:C.amber}}>eVTOL</span>
            <span style={{color:C.text}}> SIZER</span>
            <span style={{fontSize:8,color:C.dim,marginLeft:6,fontFamily:"'DM Mono',monospace",fontWeight:400}}>v2.0 — MATLAB Algorithm</span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"4px 10px",
          background:`${stCol}11`,border:`1px solid ${stCol}44`,borderRadius:4}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:stCol,boxShadow:`0 0 8px ${stCol}`}}/>
          <span style={{fontSize:9,color:stCol,fontFamily:"'DM Mono',monospace",fontWeight:700,letterSpacing:"0.08em"}}>{stTxt}</span>
        </div>
        {R&&(
          <div style={{display:"flex",gap:14,marginLeft:6,flexWrap:"wrap"}}>
            {[[" MTOW",R.MTOW,"kg",R.MTOW<4000?C.green:R.MTOW<5000?C.amber:C.red],
              ["E_total",R.Etot,"kWh",C.teal],["P_hover",R.Phov,"kW",C.blue],
              ["  L/D",R.LDact,"",R.LDact>12?C.green:C.amber],
              [" SM",(R.SM*100).toFixed(1)+"%","",R.SM>0.05&&R.SM<0.25?C.green:C.red]
            ].map(([l,v,u,col])=>(
              <div key={l} style={{textAlign:"center"}}>
                <div style={{fontSize:7,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em"}}>{l}</div>
                <div style={{fontSize:13,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",lineHeight:1.1}}>
                  {typeof v==="number"?v.toLocaleString():v}<span style={{fontSize:8,color:C.dim,marginLeft:2}}>{u}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        <button onClick={()=>setP({payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
          LD:14,AR:9,eOsw:0.85,clDesign:0.55,taper:0.45,tc:0.15,nPropHover:6,propDiam:3.0,
          etaHov:0.70,etaSys:0.80,rateOfClimb:5.08,climbAngle:5,sedCell:300,etaBat:0.90,socMin:0.2,ewf:0.50,
          fusLen:7.2,fusDiam:1.65,
          vtGamma:45,vtCh:0.28,vtCv:0.032,vtAR:2.5})}
          style={{marginLeft:"auto",padding:"5px 12px",background:"transparent",border:`1px solid ${C.border}`,
            borderRadius:4,color:C.muted,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>↺ RESET</button>
        {R&&<button onClick={()=>{
            const html=generateReport(p,R);
            const w=window.open("","_blank");
            w.document.write(html);
            w.document.close();
          }}
          style={{padding:"5px 14px",background:"linear-gradient(135deg,#1e3a5f,#1e40af)",
            border:"1px solid #3b82f6",borderRadius:4,color:"#93c5fd",fontSize:9,cursor:"pointer",
            fontFamily:"'DM Mono',monospace",fontWeight:700,letterSpacing:"0.05em",
            boxShadow:"0 0 12px #3b82f620"}}>⬇ PDF REPORT</button>}
      </div>

      <div style={{display:"flex",flex:1,overflow:"hidden"}}>
        {/* SIDEBAR */}
        <div style={{width:262,minWidth:262,background:C.panel,borderRight:`1px solid ${C.border}`,
          overflowY:"auto",padding:"10px 13px 24px"}}>
          <Acc title="Mission Requirements" icon="🛫">
            <Slider label="Payload" unit="kg" value={p.payload} min={100} max={900} step={5} onChange={set("payload")} note="Passengers + cargo"/>
            <Slider label="Range" unit="km" value={p.range} min={50} max={500} step={10} onChange={set("range")}/>
            <Slider label="Cruise Speed" unit="m/s" value={p.vCruise} min={30} max={120} step={1} onChange={set("vCruise")} note={R?`Mach ${R.Mach}`:""}/>
            <Slider label="Cruise Altitude" unit="m" value={p.cruiseAlt} min={200} max={3000} step={50} onChange={set("cruiseAlt")}/>
            <Slider label="Reserve Range" unit="km" value={p.reserveRange} min={20} max={120} step={5} onChange={set("reserveRange")}/>
            <Slider label="VTOL Height" unit="m" value={p.hoverHeight} min={10} max={50} step={0.5} onChange={set("hoverHeight")}/>
          </Acc>
          <Acc title="Aerodynamics" icon="✈️">
            <Slider label="Lift-to-Drag L/D" unit="" value={p.LD} min={5} max={22} step={0.5} onChange={set("LD")} note={R?`Actual ${R.LDact} | Archer:11.3 Joby:~16`:"Archer:11.3 Joby:~16"}/>
            <Slider label="Aspect Ratio AR" unit="" value={p.AR} min={4} max={16} step={0.5} onChange={set("AR")}/>
            <Slider label="Oswald e" unit="" value={p.eOsw} min={0.5} max={1.0} step={0.01} onChange={set("eOsw")}/>
            <Slider label="Design CL" unit="" value={p.clDesign} min={0.3} max={1.2} step={0.05} onChange={set("clDesign")} note="eVTOL cruise: 0.45–0.65"/>
            <Slider label="Taper Ratio λ" unit="" value={p.taper} min={0.2} max={0.8} step={0.05} onChange={set("taper")}/>
            <Slider label="Thickness t/c" unit="" value={p.tc} min={0.08} max={0.20} step={0.01} onChange={set("tc")}/>
          </Acc>
          <Acc title="Propulsion" icon="🔧">
            <Slider label="Hover Rotors n" unit="" value={p.nPropHover} min={2} max={10} step={2} onChange={set("nPropHover")}/>
            <Slider label="Rotor Diameter" unit="m" value={p.propDiam} min={1.0} max={5.0} step={0.1} onChange={set("propDiam")} note={R?`AD = ${R.Drotor} m`:""}/>
            <Slider label="Hover FOM η" unit="" value={p.etaHov} min={0.4} max={0.85} step={0.01} onChange={set("etaHov")} note="Optimised eVTOL rotor: 0.65–0.75"/>
            <Slider label="System η" unit="" value={p.etaSys} min={0.5} max={0.95} step={0.01} onChange={set("etaSys")} note="Motor+inverter chain: 0.78–0.85"/>
            <Slider label="Rate of Climb" unit="m/s" value={p.rateOfClimb} min={1} max={12} step={0.1} onChange={set("rateOfClimb")}/>
            <Slider label="Climb Angle" unit="°" value={p.climbAngle} min={2} max={15} step={0.5} onChange={set("climbAngle")}/>
          </Acc>
          <Acc title="Battery" icon="🔋">
            <Slider label="Cell SED" unit="Wh/kg" value={p.sedCell} min={150} max={500} step={5} onChange={set("sedCell")} note="Joby/Archer 2025: ~300 Wh/kg cell"/>
            <Slider label="Battery η" unit="" value={p.etaBat} min={0.70} max={0.99} step={0.01} onChange={set("etaBat")}/>
            <Slider label="Min SoC" unit="" value={p.socMin} min={0.05} max={0.40} step={0.01} onChange={set("socMin")}/>
          </Acc>
          <Acc title="V-Tail Design" icon="🦋">
            <Slider label="Dihedral Angle Γ" unit="°" value={p.vtGamma} min={20} max={70} step={1} onChange={set("vtGamma")}
              note={R?`Optimal: ${R.vtGamma_opt}°`:""}/>
            <Slider label="H-Tail Vol. Coeff Ch" unit="" value={p.vtCh} min={0.15} max={0.60} step={0.01} onChange={set("vtCh")} note="FBW eVTOL (NASA): 0.25–0.32"/>
            <Slider label="V-Tail Vol. Coeff Cv" unit="" value={p.vtCv} min={0.015} max={0.10} step={0.005} onChange={set("vtCv")} note="FBW eVTOL (NASA): 0.025–0.040"/>
            <Slider label="Panel Aspect Ratio" unit="" value={p.vtAR} min={1.5} max={4.0} step={0.1} onChange={set("vtAR")} note="Typical 2.0–3.0"/>
          </Acc>
          <Acc title="Structure" icon="🏗️">
            <Slider label="Empty Weight Fraction" unit="" value={p.ewf} min={0.30} max={0.70} step={0.01} onChange={set("ewf")} note="Joby:0.43 Archer:~0.45 Cora:0.55"/>
            <Slider label="Fuselage Length" unit="m" value={p.fusLen} min={3.0} max={10.0} step={0.1} onChange={set("fusLen")} note="Affects drag, stability, tail arm"/>
            <Slider label="Fuselage Diameter" unit="m" value={p.fusDiam} min={0.8} max={2.5} step={0.05} onChange={set("fusDiam")} note={`Fineness ratio: ${(p.fusLen/p.fusDiam).toFixed(1)}`}/>
          </Acc>
          {/* Design checks */}
          {R&&(
            <div style={{marginTop:10,borderTop:`1px solid ${C.border}`,paddingTop:10}}>
              <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:"'DM Mono',monospace",marginBottom:7}}>Design Checks</div>
              {R.checks.map((c,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 0",borderBottom:`1px solid #0f131a`}}>
                  <span style={{fontSize:9}}>{c.ok?"✅":"❌"}</span>
                  <span style={{fontSize:8,color:c.ok?C.green:C.red,flex:1,fontFamily:"'DM Mono',monospace"}}>{c.label}</span>
                  <span style={{fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{c.val}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* MAIN */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* Tabs */}
          <div style={{display:"flex",background:C.panel,borderBottom:`1px solid ${C.border}`,overflowX:"auto",flexShrink:0}}>
            {TABS.map((t,i)=>(
              <button key={i} onClick={()=>setTab(i)}
                style={{padding:"8px 14px",background:"transparent",border:"none",cursor:"pointer",
                  borderBottom:i===tab?`2px solid ${C.amber}`:"2px solid transparent",
                  color:i===tab?C.text:C.muted,fontSize:10,fontFamily:"'DM Mono',monospace",
                  letterSpacing:"0.05em",whiteSpace:"nowrap",transition:"color 0.15s"}}>
                {TABI[i]} {t}
              </button>
            ))}
          </div>

          <div style={{flex:1,overflowY:"auto",padding:"14px 18px 28px",background:C.bg}}>
            {!R&&<div style={{color:C.red,fontFamily:"'DM Mono',monospace",padding:20}}>Calculation error — adjust inputs.</div>}
            {R&&<>

            {/* ──── TAB 0: OVERVIEW ──── */}
            {tab===0&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="MTOW" value={R.MTOW} unit="kg" color={R.MTOW<4000?C.green:R.MTOW<5000?C.amber:C.red} sub={`R1: ${R.MTOW1} kg`}/>
                  <KPI label="Battery Mass" value={R.Wbat} unit="kg" color={R.Wbat/R.MTOW<0.4?C.green:C.amber} sub={`${(R.Wbat/R.MTOW*100).toFixed(1)}% of MTOW`}/>
                  <KPI label="Total Energy" value={R.Etot} unit="kWh" color={C.teal} sub={`Pack: ${R.PackkWh} kWh`}/>
                  <KPI label="Actual L/D" value={R.LDact} unit="" color={R.LDact>12?C.green:C.amber} sub={`CD₀=${R.CD0tot} CDi=${R.CDi}`}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Wing Area" value={R.Swing} unit="m²" sub={`Span ${R.bWing} m`}/>
                  <KPI label="Hover Power" value={R.Phov} unit="kW" color={C.blue} sub={`Cruise ${R.Pcr} kW`}/>
                  <KPI label="Static Margin" value={(R.SM*100).toFixed(1)} unit="% MAC" color={R.SM>0.05&&R.SM<0.25?C.green:C.red}/>
                  <KPI label="Mach" value={R.Mach} unit="" color={R.Mach<0.35?C.green:C.amber} sub={`Re ${(R.Re_/1e6).toFixed(2)}×10⁶`}/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Power per Phase (kW)" h={255}>
                    <ResponsiveContainer width="100%" height={205}>
                      <BarChart data={[{ph:"T/O",v:R.Phov},{ph:"Climb",v:R.Pcl},{ph:"Cruise",v:R.Pcr},{ph:"Descent",v:R.Pdc},{ph:"Land",v:R.Phov},{ph:"Reserve",v:R.Pres}]}
                        margin={{top:5,right:8,left:-15,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="kW">{PHC.map((c,i)=><Cell key={i} fill={c}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Energy per Phase (kWh)" h={255}>
                    <ResponsiveContainer width="100%" height={205}>
                      <BarChart data={[{ph:"T/O",v:R.Eto},{ph:"Climb",v:R.Ecl},{ph:"Cruise",v:R.Ecr},{ph:"Descent",v:R.Edc},{ph:"Land",v:R.Eld},{ph:"Reserve",v:R.Eres}]}
                        margin={{top:5,right:8,left:-15,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="kWh">{PHC.map((c,i)=><Cell key={i} fill={c}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
                <Panel title="Mission Timeline — Final Converged Values">
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                      <thead><tr style={{background:"#111927"}}>
                        {["Phase","Time (s)","Power (kW)","Energy (kWh)","Velocity (m/s)"].map(h=>(
                          <th key={h} style={{padding:"5px 12px",textAlign:"left",color:C.muted,fontFamily:"'DM Mono',monospace",fontSize:8,fontWeight:600,letterSpacing:"0.05em"}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {[["🛫 Takeoff Hover",R.tto,R.Phov,R.Eto,0.5],
                          ["📈 Climb",R.tcl,R.Pcl,R.Ecl,+(p.rateOfClimb/Math.sin(p.climbAngle*Math.PI/180)).toFixed(1)],
                          ["✈️ Cruise",R.tcr,R.Pcr,R.Ecr,p.vCruise],
                          ["📉 Descent",R.tdc,R.Pdc,R.Edc,+(p.cruiseAlt/Math.tan(Math.atan(1/p.LD))/R.tdc).toFixed(1)],
                          ["🛬 Landing Hover",R.tld,R.Phov,R.Eld,0.5],
                          ["🔄 Reserve",R.tres,R.Pres,R.Eres,+(0.7*p.vCruise).toFixed(1)],
                        ].map(([ph,t,pw,e,v],i)=>(
                          <tr key={i} style={{borderTop:`1px solid ${C.border}`,background:i%2?"#0a0d14":C.bg}}>
                            <td style={{padding:"6px 12px",color:C.text,fontWeight:600}}>{ph}</td>
                            <td style={{padding:"6px 12px",color:C.amber,fontFamily:"'DM Mono',monospace"}}>{t}</td>
                            <td style={{padding:"6px 12px",color:PHC[i],fontFamily:"'DM Mono',monospace"}}>{pw}</td>
                            <td style={{padding:"6px 12px",color:C.teal,fontFamily:"'DM Mono',monospace"}}>{e}</td>
                            <td style={{padding:"6px 12px",color:C.muted,fontFamily:"'DM Mono',monospace"}}>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              </div>
            )}

            {/* ──── TAB 1: MISSION ──── */}
            {tab===1&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <Panel title="Power vs Mission Time" h={270}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={R.powerSteps} margin={{top:5,right:10,left:-10,bottom:0}}>
                      <defs><linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.amber} stopOpacity={0.4}/><stop offset="95%" stopColor={C.amber} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"kW",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP}/>
                      <Area type="stepAfter" dataKey="P" stroke={C.amber} strokeWidth={2} fill="url(#pg)" dot={false} name="Power (kW)"/>
                      {R.tPhases.slice(1,-1).map((tp,i)=><ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>)}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>
                <Panel title="Velocity vs Mission Time" h={230}>
                  <ResponsiveContainer width="100%" height={180}>
                    <AreaChart data={R.velSteps} margin={{top:5,right:10,left:-10,bottom:0}}>
                      <defs><linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.teal} stopOpacity={0.4}/><stop offset="95%" stopColor={C.teal} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"m/s",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP}/>
                      <Area type="stepAfter" dataKey="V" stroke={C.teal} strokeWidth={2} fill="url(#vg)" dot={false} name="Speed (m/s)"/>
                      <ReferenceLine y={p.vCruise} stroke={C.blue} strokeDasharray="4 3" label={{value:"Vcr",fill:C.blue,fontSize:11}}/>
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                {/* ── Energy vs Mission Time ── */}
                <Panel title="Energy vs Mission Time" h={270}>
                  <ResponsiveContainer width="100%" height={220}>
                    <AreaChart data={R.energySteps} margin={{top:5,right:10,left:-10,bottom:0}}>
                      <defs><linearGradient id="eg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.green} stopOpacity={0.4}/><stop offset="95%" stopColor={C.green} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"kWh",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${v} kWh`,"Cumulative Energy"]}/>
                      <ReferenceLine y={R.Etot} stroke={C.amber} strokeDasharray="4 3" strokeWidth={1.5}
                        label={{value:`Total ${R.Etot} kWh`,position:"insideTopRight",fontSize:11,fill:C.amber}}/>
                      <Area type="monotone" dataKey="E" stroke={C.green} strokeWidth={2} fill="url(#eg)" dot={false} name="Energy (kWh)"/>
                      {R.tPhases.slice(1,-1).map((tp,i)=><ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>)}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>

                {/* ── Power & Energy vs Mission Time (dual-axis) ── */}
                <Panel title="Power & Energy vs Mission Time" h={290}>
                  <ResponsiveContainer width="100%" height={240}>
                    <ComposedChart data={R.energySteps} margin={{top:5,right:50,left:-10,bottom:0}}>
                      <defs><linearGradient id="pg2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.amber} stopOpacity={0.35}/><stop offset="95%" stopColor={C.amber} stopOpacity={0.02}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis yAxisId="pwr" orientation="left"
                        tick={{fontSize:11,fill:C.amber}}
                        label={{value:"Power (kW)",angle:-90,position:"insideLeft",fontSize:12,fill:C.amber}}/>
                      <YAxis yAxisId="eng" orientation="right"
                        tick={{fontSize:11,fill:C.green}}
                        label={{value:"Energy (kWh)",angle:90,position:"insideRight",fontSize:12,fill:C.green}}/>
                      <Tooltip {...TTP} formatter={(v,n)=>n==="Power (kW)"?[`${v} kW`,n]:[`${v} kWh`,n]}/>
                      <Legend iconSize={9} wrapperStyle={{fontSize:12,color:"#94a3b8"}}/>
                      {R.tPhases.slice(1,-1).map((tp,i)=>
                        <ReferenceLine key={i} yAxisId="pwr" x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>)}
                      <Area yAxisId="pwr" type="stepAfter" dataKey="P" stroke={C.amber} strokeWidth={2}
                        fill="url(#pg2)" dot={false} name="Power (kW)"/>
                      <Line yAxisId="eng" type="monotone" dataKey="E" stroke={C.green} strokeWidth={2}
                        dot={false} name="Energy (kWh)"/>
                    </ComposedChart>
                  </ResponsiveContainer>
                </Panel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Phase Duration" h={240}>
                    <ResponsiveContainer width="100%" height={195}>
                      <PieChart>
                        <Pie data={[{n:"T/O",v:R.tto},{n:"Climb",v:R.tcl},{n:"Cruise",v:R.tcr},{n:"Descent",v:R.tdc},{n:"Land",v:R.tld},{n:"Reserve",v:R.tres}]}
                          dataKey="v" nameKey="n" cx="50%" cy="50%" innerRadius={45} outerRadius={80} paddingAngle={3}>
                          {PHC.map((c,i)=><Cell key={i} fill={c}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v)=>[`${v} s`,"Duration"]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:12,color:"#94a3b8"}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Energy Radar" h={240}>
                    <ResponsiveContainer width="100%" height={195}>
                      <RadarChart data={[{ph:"T/O",E:R.Eto},{ph:"Climb",E:R.Ecl},{ph:"Cruise",E:R.Ecr},{ph:"Desc",E:R.Edc},{ph:"Land",E:R.Eld},{ph:"Res",E:R.Eres}]}>
                        <PolarGrid stroke={C.border}/>
                        <PolarAngleAxis dataKey="ph" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Radar dataKey="E" stroke={C.teal} fill={C.teal} fillOpacity={0.2} name="kWh"/>
                        <Tooltip {...TTP}/>
                      </RadarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 2: WING & AERO ──── */}
            {tab===2&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Wing Area" value={R.Swing} unit="m²"/><KPI label="Wing Span" value={R.bWing} unit="m"/>
                  <KPI label="MAC" value={R.MAC} unit="m"/><KPI label="Sweep" value={R.sweep} unit="°"/>
                  <KPI label="Root Chord" value={R.Cr_} unit="m"/><KPI label="Tip Chord" value={R.Ct_} unit="m"/>
                  <KPI label="Wing Loading" value={R.WL} unit="N/m²"/><KPI label="Reynolds ×10⁶" value={(R.Re_/1e6).toFixed(2)} unit=""/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="CD₀ Breakdown (Raymer Buildup)" h={265}>
                    <ResponsiveContainer width="100%" height={215}>
                      <PieChart>
                        <Pie data={R.dragComp} dataKey="val" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={85} paddingAngle={3}>
                          {["#3b82f6","#ef4444","#22c55e","#f59e0b","#8b5cf6","#ec4899","#06b6d4"].map((c,i)=><Cell key={i} fill={c}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v)=>[v.toFixed(5),"CD₀"]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:12,color:"#94a3b8"}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Airfoil Selection Score" h={265}>
                    <div style={{height:215,overflowY:"auto"}}>
                      {[...R.afScored].sort((a,b)=>b.score-a.score).map((af,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:7,padding:"4px 0",borderBottom:`1px solid ${C.border}`}}>
                          <span style={{fontSize:9,minWidth:92,color:af.name===R.selAF.name?C.green:C.text,
                            fontFamily:"'DM Mono',monospace",fontWeight:af.name===R.selAF.name?700:400}}>
                            {af.name===R.selAF.name?"★ ":""}{af.name}
                          </span>
                          <div style={{flex:1,height:4,background:C.border,borderRadius:2}}>
                            <div style={{height:"100%",width:`${af.score*100}%`,background:af.name===R.selAF.name?C.green:C.muted,borderRadius:2}}/>
                          </div>
                          <span style={{fontSize:9,color:af.name===R.selAF.name?C.green:C.muted,fontFamily:"'DM Mono',monospace",minWidth:36,textAlign:"right"}}>
                            {(af.score*100).toFixed(1)}%
                          </span>
                        </div>
                      ))}
                      <div style={{marginTop:8,fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace"}}>
                        ★ {R.selAF.name} | t/c={R.selAF.tc} CLmax={R.selAF.CLmax} CDmin={R.selAF.CDmin}
                      </div>
                    </div>
                  </Panel>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <Panel title="Drag Polar" h={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <LineChart data={R.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="CD" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"CD",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"CL",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Line type="monotone" dataKey="CL" stroke={C.blue} strokeWidth={2} dot={false}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Lift Curve" h={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <LineChart data={R.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="alpha" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"α (°)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Line type="monotone" dataKey="CL" stroke={C.green} strokeWidth={2} dot={false}/>
                        <ReferenceLine y={p.clDesign} stroke={C.amber} strokeDasharray="3 3" label={{value:"CL_des",fill:C.amber,fontSize:11}}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="L/D Ratio" h={235}>
                    <ResponsiveContainer width="100%" height={185}>
                      <AreaChart data={R.polarData} margin={{top:5,right:8,left:-20,bottom:0}}>
                        <defs><linearGradient id="ldg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={C.amber} stopOpacity={0.3}/><stop offset="95%" stopColor={C.amber} stopOpacity={0}/>
                        </linearGradient></defs>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="alpha" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"α (°)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Area type="monotone" dataKey="LD" stroke={C.amber} strokeWidth={2} fill="url(#ldg)" dot={false}/>
                        <ReferenceLine y={R.LDact} stroke={C.green} strokeDasharray="3 3" label={{value:`${R.LDact}`,fill:C.green,fontSize:11}}/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
                {/* ──── Wing Planform SVG ──── */}
                <Panel title="Wing Planform — Top View">
                  {(()=>{
                    const W=680, H=220, margin={l:60,r:60,t:28,b:28};
                    const b=R.bWing, Cr=R.Cr_, Ct=R.Ct_, sw=R.sweep*Math.PI/180;
                    const mac=R.MAC, ymac=R.Ymac;
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
                      {[0.25,0.5,0.75,1.0].map(f=>{
                        const xg=f*b/2*sc;
                        return <line key={f} x1={cx+xg} y1={margin.t-8} x2={cx+xg} y2={H-margin.b+5}
                          stroke="#1e2a3a" strokeWidth={1} strokeDasharray="3 3"/>;
                      })}
                      {/* Right half */}
                      <polygon points={`${pt(xRoot,yRoot)} ${pt(xTip,yTip)} ${pt(xTipTe,yTipTe)} ${pt(xRootTe,yRootTe)}`}
                        fill="#1e3a5f" stroke="#3b82f6" strokeWidth={1.5} opacity={0.85}/>
                      {/* Left half */}
                      <polygon points={`${ptL(xRoot,yRoot)} ${ptL(xTip,yTip)} ${ptL(xTipTe,yTipTe)} ${ptL(xRootTe,yRootTe)}`}
                        fill="#1e3a5f" stroke="#3b82f6" strokeWidth={1.5} opacity={0.85}/>
                      {/* Root chord */}
                      <line x1={cx} y1={yRoot} x2={cx} y2={yRootTe} stroke="#94a3b8" strokeWidth={1} strokeDasharray="4 2"/>
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
                      <text x={cx} y={H-margin.b+22} textAnchor="middle" fill="#94a3b8" fontSize={9}>b = {b} m</text>
                      {/* Root chord label */}
                      <text x={cx+6} y={(yRoot+yRootTe)/2+3} fill="#94a3b8" fontSize={8}>Cr={Cr}m</text>
                      {/* Tip chord label */}
                      <text x={cx+xTip+4} y={(yTip+yTipTe)/2+3} fill="#94a3b8" fontSize={8}>Ct={Ct}m</text>
                      {/* MAC label */}
                      <text x={cx+xMac+6} y={yMacLE+mac*sc/2+3} fill="#22c55e" fontSize={8}>MAC={mac}m</text>
                      {/* Sweep annotation */}
                      <text x={cx+12} y={yRootQC-4} fill="#f59e0b" fontSize={8}>Λ¼={R.sweep}°</text>
                      {/* LE label */}
                      <text x={cx-xTip-4} y={yTip-4} textAnchor="end" fill="#3b82f6" fontSize={8}>LE</text>
                      <text x={cx-xTipTe-4} y={yTipTe+4} textAnchor="end" fill="#3b82f6" fontSize={8}>TE</text>
                      {/* Span fraction ticks */}
                      {[0.25,0.5,0.75].map(f=>(
                        <text key={f} x={cx+f*b/2*sc} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>{Math.round(f*100)}%</text>
                      ))}
                      <text x={cx+b/2*sc} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>tip</text>
                      <text x={cx} y={margin.t-10} textAnchor="middle" fill="#334155" fontSize={7}>CL</text>
                      {/* AR / taper info */}
                      <text x={8} y={16} fill="#475569" fontSize={8}>AR={p.AR}  λ={p.taper}  t/c={p.tc}  Sw={R.Swing}m²</text>
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
            {tab===3&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Rotor Diam (AD)" value={R.Drotor} unit="m" color={C.amber}/>
                  <KPI label="Disk Loading" value={R.DLrotor} unit="N/m²"/>
                  <KPI label="Tip Speed" value={R.TipSpd} unit="m/s" color={R.TipMach<0.7?C.green:C.red} sub={`Tip Mach ${R.TipMach}`}/>
                  <KPI label="RPM" value={R.RPM} unit="rpm"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Actuator Disk + Motor Sizing" h={380}>
                    <div style={{overflowY:"auto",maxHeight:320}}>
                    {[["No. rotors (hover)",p.nPropHover],["Design diameter",`${p.propDiam} m`],
                      ["AD-derived diameter",`${R.Drotor} m`],["Disk loading",`${R.DLrotor} N/m²`],
                      ["Power loading",`${R.PLrotor} N/kW`],["Tip speed",`${R.TipSpd} m/s`],
                      ["Tip Mach",R.TipMach],["Operating RPM",`${R.RPM} rpm`],
                      ["No. blades",R.Nbld],["Solidity σ","0.10"],
                      ["Blade chord",`${R.ChordBl} m`],["Blade AR",R.BladeAR],
                      ["Continuous power/rotor",`${R.PmotKW} kW`],["Peak power/rotor",`${R.PpeakKW} kW`],
                      ["Shaft torque",`${R.Torque} N·m`],["Motor mass/rotor",`${R.MotMass} kg`],
                      ["Total motor mass",`${(R.MotMass*p.nPropHover).toFixed(1)} kg`],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:10,color:"#94a3b8"}}>{k}</span>
                        <span style={{fontSize:10,color:C.amber,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                      </div>
                    ))}
                    </div>
                  </Panel>
                  <Panel title="Phase Power Comparison" h={320}>
                    <ResponsiveContainer width="100%" height={270}>
                      <BarChart data={[{ph:"T/O",v:R.Phov},{ph:"Climb",v:R.Pcl},{ph:"Cruise",v:R.Pcr},{ph:"Descent",v:R.Pdc},{ph:"Land",v:R.Phov},{ph:"Reserve",v:R.Pres}]}
                        margin={{top:5,right:8,left:-10,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="ph" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"kW",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="v" radius={[3,3,0,0]} name="Power (kW)">{PHC.map((c,i)=><Cell key={i} fill={c}/>)}</Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 4: BATTERY ──── */}
            {tab===4&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Pack Energy" value={R.PackkWh} unit="kWh" color={C.green} sub={`Mission: ${R.Etot} kWh`}/>
                  <KPI label="Battery Mass" value={R.Wbat} unit="kg" color={R.Wbat/R.MTOW<0.4?C.green:C.amber} sub={`SED ${R.SEDpack} Wh/kg`}/>
                  <KPI label="Cell Config" value={`${R.Nseries}s×${R.Npar}p`} unit="" sub={`${R.Ncells} cells total`}/>
                  <KPI label="Final SoC" value={((1-R.Etot/R.PackkWh)*100).toFixed(1)} unit="%" color={(1-R.Etot/R.PackkWh)>=(p.socMin/(1+p.socMin))-0.01?C.green:C.red}/>
                </div>
                <Panel title="Battery State of Charge — Full Mission" h={285}>
                  <ResponsiveContainer width="100%" height={235}>
                    <AreaChart data={R.socSteps} margin={{top:5,right:10,left:-10,bottom:0}}>
                      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={C.green} stopOpacity={0.5}/><stop offset="95%" stopColor={C.red} stopOpacity={0.05}/>
                      </linearGradient></defs>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="t" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Time (s)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis domain={[0,105]} tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"SoC (%)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP} formatter={(v)=>[`${v}%`,"SoC"]}/>
                      <ReferenceLine y={p.socMin/(1+p.socMin)*100} stroke={C.red} strokeDasharray="5 3"
                        label={{value:`SoCmin ${(p.socMin/(1+p.socMin)*100).toFixed(1)}%`,fill:C.red,fontSize:11,position:"right"}}/>
                      <Area type="stepAfter" dataKey="SoC" stroke={C.green} strokeWidth={2.5} fill="url(#sg)" dot={false}/>
                      {R.tPhases.slice(1,-1).map((tp,i)=><ReferenceLine key={i} x={Math.round(tp)} stroke={PHC[i]} strokeDasharray="4 3" strokeWidth={1}/>)}
                    </AreaChart>
                  </ResponsiveContainer>
                </Panel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Pack Architecture (21700 NMC)" h={260}>
                    {[["Cell voltage","3.6 V"],["Cell capacity","5.0 Ah"],["Bus voltage",`${R.PackV} V`],
                      ["Series cells",R.Nseries],["Parallel strings",R.Npar],["Total cells",R.Ncells],
                      ["Pack energy",`${R.PackkWh} kWh`],["Battery mass",`${R.Wbat} kg`],
                      ["SED (pack)",`${R.SEDpack} Wh/kg`],["C-rate hover",`${R.CrateHov}C`],
                      ["C-rate cruise",`${R.CrateCr}C`],["Joule heating",`${R.Pheat} W`],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:9,color:C.muted}}>{k}</span>
                        <span style={{fontSize:9,color:C.teal,fontFamily:"'DM Mono',monospace"}}>{v}</span>
                      </div>
                    ))}
                  </Panel>
                  <Panel title="SoC per Phase" h={260}>
                    {(()=>{
                      const E=[0,R.Eto,R.Eto+R.Ecl,R.Eto+R.Ecl+R.Ecr,R.Eto+R.Ecl+R.Ecr+R.Edc,R.Eto+R.Ecl+R.Ecr+R.Edc+R.Eld,R.Etot];
                      return["Start","After T/O","After Climb","After Cruise","After Descent","After Landing","After Reserve"].map((lbl,i)=>{
                        const soc=Math.max(0,(1-E[i]/R.PackkWh)*100),col=soc>60?C.green:soc>30?C.amber:C.red;
                        return(<div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 0",borderBottom:`1px solid ${C.border}`}}>
                          <span style={{fontSize:8,color:C.muted,minWidth:95,fontFamily:"'DM Mono',monospace"}}>{lbl}</span>
                          <div style={{flex:1,height:5,background:C.border,borderRadius:2}}>
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
            {tab===5&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Stall Speed Vs" value={R.Vstall} unit="m/s"/>
                  <KPI label="Corner Speed Va" value={R.VA} unit="m/s"/>
                  <KPI label="Cruise Speed" value={p.vCruise} unit="m/s"/>
                  <KPI label="Dive Speed Vd" value={R.VD} unit="m/s"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="V-n Structural Envelope" h={310}>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={R.vnData} margin={{top:10,right:30,left:10,bottom:20}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="v" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Airspeed (m/s)",position:"insideBottom",offset:-8,fontSize:12,fill:"#94a3b8"}}/>
                        <YAxis domain={[-2.5,4.5]} tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Load factor n",angle:-90,position:"insideLeft",offset:10,fontSize:12,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <ReferenceLine y={0} stroke={C.muted}/>
                        <ReferenceLine y={3.5} stroke={C.blue} strokeDasharray="4 3" label={{value:"n=3.5",fill:C.blue,fontSize:11,fontWeight:600}}/>
                        <ReferenceLine y={-1.5} stroke={C.red} strokeDasharray="4 3" label={{value:"n=-1.5",fill:C.red,fontSize:11,fontWeight:600}}/>
                        <ReferenceLine x={R.Vstall} stroke={C.amber} strokeDasharray="4 3" label={{value:"Vs",fill:C.amber,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={R.VA} stroke={C.green} strokeDasharray="4 3" label={{value:"Va",fill:C.green,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={p.vCruise} stroke={C.teal} strokeDasharray="4 3" label={{value:"Vc",fill:C.teal,fontSize:11,fontWeight:600,position:"top"}}/>
                        <ReferenceLine x={R.VD} stroke={C.red} strokeDasharray="4 3" label={{value:"Vd",fill:C.red,fontSize:11,fontWeight:600,position:"top"}}/>
                        <Line type="monotone" dataKey="nPos" stroke={C.blue} strokeWidth={2.5} dot={false} name="+n limit"/>
                        <Line type="monotone" dataKey="nNeg" stroke={C.red} strokeWidth={2.5} dot={false} name="-n limit"/>
                        <Legend iconSize={10} wrapperStyle={{fontSize:12,color:"#94a3b8",paddingTop:4}}/>
                      </LineChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Range-Payload Diagram" h={310}>
                    <ResponsiveContainer width="100%" height={260}>
                      <AreaChart data={R.rpData} margin={{top:10,right:20,left:10,bottom:20}}>
                        <defs><linearGradient id="rpg" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4}/><stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.02}/>
                        </linearGradient></defs>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis dataKey="payload" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Payload (kg)",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                        <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Range (km)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <ReferenceLine x={p.payload} stroke={C.amber} strokeDasharray="4 3" label={{value:"Design",fill:C.amber,fontSize:11}}/>
                        <ReferenceLine y={p.range} stroke={C.amber} strokeDasharray="4 3"/>
                        <Area type="monotone" dataKey="range" stroke="#8b5cf6" strokeWidth={2} fill="url(#rpg)" dot={false} name="Range (km)"/>
                      </AreaChart>
                    </ResponsiveContainer>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 6: STABILITY ──── */}
            {tab===6&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="CG (MTOW)" value={R.xCGtotal} unit="m from nose"/>
                  <KPI label="Neutral Point" value={R.xNP} unit="m from nose"/>
                  <KPI label="Static Margin" value={(R.SM*100).toFixed(1)} unit="% MAC" color={R.SM>=0.05&&R.SM<=0.25?C.green:C.red}/>
                  <KPI label="MAC" value={R.MAC} unit="m"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="CG / NP / AC Positions (from nose)" h={320}>
                    <div style={{position:"relative",height:90,margin:"10px 0 8px",background:"#0a0d14",borderRadius:6,border:"1px solid #1c2333"}}>
                      {/* fuselage body */}
                      <div style={{position:"absolute",left:"10%",right:"8%",top:"44%",height:4,background:"#1e2a3a",borderRadius:2}}/>
                      {/* nose */}
                      <div style={{position:"absolute",left:"6%",top:"30%",fontSize:24}}>✈️</div>
                      {/* length label */}
                      <div style={{position:"absolute",right:"2%",bottom:4,fontSize:10,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{p.fusLen} m</div>
                      {/* scale ticks */}
                      {[0.25,0.5,0.75,1.0].map(frac=>(
                        <div key={frac} style={{position:"absolute",left:`${10+frac*82}%`,top:"55%",width:1,height:12,background:"#1e2a3a"}}/>
                      ))}
                      {[[R.xCGtotal,C.amber,"CG"],[R.xNP,C.blue,"NP"],[1.45+R.Xac,C.green,"AC"]].map(([x,col,lbl])=>{
                        const pct=Math.min(92,Math.max(10,(x/p.fusLen)*82+10));
                        return(<div key={lbl} style={{position:"absolute",left:`${pct}%`,top:0,bottom:0,transform:"translateX(-50%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
                          <div style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700,
                            writingMode:"vertical-rl",textOrientation:"mixed",transform:"rotate(180deg)",
                            letterSpacing:"0.05em",lineHeight:1,marginBottom:4,whiteSpace:"nowrap"}}>
                            {lbl}={x}m
                          </div>
                          <div style={{width:2,height:"100%",background:col,opacity:0.85,borderRadius:1,minHeight:60}}/>
                        </div>);
                      })}
                    </div>
                    {[["CG (MTOW)",`${R.xCGtotal} m`],["Wing AC",`${(1.45+R.Xac).toFixed(3)} m`],
                      ["Neutral Point",`${R.xNP} m`],["Static Margin",`${(R.SM*100).toFixed(1)}% MAC`],
                      ["MAC",`${R.MAC} m`],["Status",R.SM>=0.05&&R.SM<=0.25?"✅ OK (5–25%)":R.SM<0.05?"⚠️ Too small":"⚠️ Too large"],
                    ].map(([k,v],i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                        <span style={{fontSize:10,color:C.muted}}>{k}</span>
                        <span style={{fontSize:10,color:C.amber,fontFamily:"'DM Mono',monospace"}}>{v}</span>
                      </div>
                    ))}
                  </Panel>
                  <Panel title="Empty Weight Breakdown (Roskam)" h={290}>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart layout="vertical" data={R.weightBreak} margin={{top:0,right:30,left:60,bottom:0}}>
                        <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                        <XAxis type="number" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <YAxis dataKey="name" type="category" tick={{fontSize:11,fill:"#94a3b8"}}/>
                        <Tooltip {...TTP}/>
                        <Bar dataKey="val" radius={[0,3,3,0]} name="kg">
                          {R.weightBreak.map((_,i)=><Cell key={i} fill={["#3b82f6","#ef4444","#22c55e","#f59e0b","#8b5cf6","#ec4899","#06b6d4","#84cc16","#f97316","#a78bfa"][i]}/>)}
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
                    const xCGbat=p.fusLen*0.38, xCGpay=p.fusLen*0.40;
                    const pts=Array.from({length:51},(_,i)=>{
                      const frac=i/50;
                      // Linear blend: OEW → full battery → full payload
                      const Wb=R.Wbat*frac, Wp=p.payload*frac;
                      const W=R.Wempty+Wb+Wp;
                      const cg=(R.Wempty*R.xCGempty+Wb*xCGbat+Wp*xCGpay)/W;
                      return{mass:+W.toFixed(1),cg:+cg.toFixed(4),sm:+((R.xNP-cg)/R.MAC*100).toFixed(2)};
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
                            <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                            <XAxis dataKey="mass" tick={{fontSize:10,fill:"#94a3b8"}}
                              label={{value:"Mass (kg)",position:"insideBottom",offset:-6,fontSize:10,fill:"#94a3b8"}}/>
                            <YAxis domain={["auto","auto"]} tick={{fontSize:10,fill:"#94a3b8"}}
                              label={{value:"xCG (m)",angle:-90,position:"insideLeft",offset:12,fontSize:10,fill:"#94a3b8"}}/>
                            <Tooltip {...TTP} formatter={(v,n)=>[`${v} m`,n]}/>
                            <ReferenceLine y={R.xNP} stroke={C.blue} strokeDasharray="4 2"
                              label={{value:"NP",fill:C.blue,fontSize:9,position:"right"}}/>
                            <ReferenceLine y={R.xCGempty} stroke="#64748b" strokeDasharray="3 2"
                              label={{value:"OEW",fill:"#64748b",fontSize:9,position:"right"}}/>
                            <ReferenceLine y={R.xCGtotal} stroke={C.amber} strokeDasharray="3 2"
                              label={{value:"MTOW",fill:C.amber,fontSize:9,position:"right"}}/>
                            <Line type="monotone" dataKey="cg" stroke={C.green} strokeWidth={2} dot={false} name="xCG"/>
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
                                <stop offset="5%" stopColor={C.green} stopOpacity={0.3}/>
                                <stop offset="95%" stopColor={C.green} stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                            <XAxis dataKey="mass" tick={{fontSize:10,fill:"#94a3b8"}}
                              label={{value:"Mass (kg)",position:"insideBottom",offset:-6,fontSize:10,fill:"#94a3b8"}}/>
                            <YAxis tick={{fontSize:10,fill:"#94a3b8"}}
                              label={{value:"SM (%)",angle:-90,position:"insideLeft",offset:15,fontSize:10,fill:"#94a3b8"}}/>
                            <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                            <ReferenceLine y={5} stroke={C.red} strokeDasharray="3 2"
                              label={{value:"5% min",fill:C.red,fontSize:9,position:"right"}}/>
                            <ReferenceLine y={25} stroke={C.red} strokeDasharray="3 2"
                              label={{value:"25% max",fill:C.red,fontSize:9,position:"right"}}/>
                            <Area type="monotone" dataKey="sm" stroke={C.green} strokeWidth={2} fill="url(#smg)" dot={false} name="SM %"/>
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>);
                  })()}
                  <div style={{display:"flex",gap:18,marginTop:8,padding:"5px 8px",background:"#0a0d14",borderRadius:4}}>
                    {[["OEW CG",`${R.xCGempty} m`,"#64748b"],["MTOW CG",`${R.xCGtotal} m`,C.amber],
                      ["NP",`${R.xNP} m`,C.blue],["ΔCG travel",`${Math.abs(R.xCGtotal-R.xCGempty).toFixed(3)} m`,C.green]
                    ].map(([l,v,col])=>(
                      <div key={l} style={{display:"flex",flexDirection:"column",gap:2}}>
                        <span style={{fontSize:8,color:"#64748b",fontFamily:"'DM Mono',monospace"}}>{l}</span>
                        <span style={{fontSize:11,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="MTOW Composition" h={235}>
                    <ResponsiveContainer width="100%" height={190}>
                      <PieChart>
                        <Pie data={[{name:"Empty",val:R.Wempty},{name:"Battery",val:R.Wbat},{name:"Payload",val:p.payload}]}
                          dataKey="val" nameKey="name" cx="50%" cy="50%" innerRadius={48} outerRadius={82} paddingAngle={4}>
                          {[C.blue,C.amber,C.green].map((c,i)=><Cell key={i} fill={c}/>)}
                        </Pie>
                        <Tooltip {...TTP} formatter={(v,n)=>[`${v.toFixed(1)} kg (${(v/R.MTOW*100).toFixed(1)}%)`,n]}/>
                        <Legend iconSize={8} wrapperStyle={{fontSize:12,color:"#94a3b8"}}/>
                      </PieChart>
                    </ResponsiveContainer>
                  </Panel>
                  <Panel title="Feasibility Checks" h={235}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginTop:4}}>
                      {R.checks.map((c,i)=>(
                        <div key={i} style={{background:C.bg,borderRadius:5,padding:"7px 9px",border:`1px solid ${c.ok?C.green+"33":C.red+"33"}`}}>
                          <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:2}}>
                            <span>{c.ok?"✅":"❌"}</span>
                            <span style={{fontSize:8,color:c.ok?C.green:C.red,fontWeight:700,fontFamily:"'DM Mono',monospace"}}>{c.ok?"PASS":"FAIL"}</span>
                          </div>
                          <div style={{fontSize:8,color:C.muted,marginBottom:2}}>{c.label}</div>
                          <div style={{fontSize:9,color:c.ok?C.green:C.red,fontFamily:"'DM Mono',monospace"}}>{c.val}</div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                </div>
              </div>
            )}

            {/* ──── TAB 7: V-TAIL SIZING ──── */}
            {tab===7&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* KPI row */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10}}>
                  <KPI label="Total V-Tail Area" value={R.Svt_total} unit="m²" color={C.amber}
                    sub={`Each panel: ${R.Svt_panel} m²`}/>
                  <KPI label="Tail / Wing Area" value={(R.tailWingRatio*100).toFixed(1)} unit="%"
                    color={R.tailWingRatio>=0.20&&R.tailWingRatio<=0.55?C.green:C.red}
                    sub="Target: 25–50%"/>
                  <KPI label="Optimal Dihedral Γ" value={R.vtGamma_opt} unit="°" color={C.teal}
                    sub={`Set: ${p.vtGamma}°`}/>
                  <KPI label="Static Margin (w/ Vtail)" value={(R.SM_vt*100).toFixed(1)} unit="% MAC"
                    color={R.SM_vt>=0.05&&R.SM_vt<=0.25?C.green:C.red}
                    sub={`Baseline: ${(R.SM*100).toFixed(1)}%`}/>
                  <KPI label="Ruddervator Area" value={R.Srv} unit="m²/panel" color={C.blue}
                    sub="30% chord"/>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  {/* Panel Geometry */}
                  <div style={{display:"flex",flexDirection:"column",gap:10}}>
                    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>
                        Panel Geometry
                      </div>
                      {[["Panel span",`${R.bvt_panel} m`],["Root chord",`${R.Cr_vt} m`],
                        ["Tip chord",`${R.Ct_vt} m`],["MAC",`${R.MAC_vt} m`],
                        ["LE sweep",`${R.sweep_vt}°`],["Taper ratio","0.40"],
                        ["Airfoil","NACA 0009"],["t/c","9%"],
                        ["Tail moment arm lv",`${R.lv} m`],["Ruddervator / panel",`${R.Srv} m²`],
                        ["Lf/b ratio",`${R.fusSpanRatio} (target 0.55–0.70)`],
                      ].map(([k,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                          <span style={{fontSize:10,color:"#64748b"}}>{k}</span>
                          <span style={{fontSize:10,color:C.amber,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>
                        Weight & Drag
                      </div>
                      {[["V-tail total mass",`${R.Wvt_total} kg`],
                        ["V-tail CD₀ contrib.",`${R.CD0vt.toFixed(5)}`],
                        ["Ruddervator trim δ",`${R.delta_rv_deg}°`],
                      ].map(([k,v],i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid #0f131a`}}>
                          <span style={{fontSize:10,color:"#64748b"}}>{k}</span>
                          <span style={{fontSize:10,color:C.teal,fontFamily:"'DM Mono',monospace",fontWeight:600}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    {/* SVG schematic — below Weight & Drag, beside Control Authority */}
                    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>
                        Rear View Schematic
                      </div>
                      <svg viewBox="-110 -95 220 130" width="100%" height={160} style={{overflow:"visible"}}>
                        <circle cx={0} cy={0} r={12} fill="#1e2a3a" stroke="#2a3a5c" strokeWidth={1.5}/>
                        <text x={0} y={4} textAnchor="middle" fill="#64748b" fontSize={7} fontFamily="DM Mono,monospace">fus</text>
                        {(()=>{
                          const gr=p.vtGamma*Math.PI/180;
                          const panelLen=65;
                          const x2l=-(panelLen*Math.cos(gr)), y2l=-(panelLen*Math.sin(gr));
                          const x2r= (panelLen*Math.cos(gr)), y2r=-(panelLen*Math.sin(gr));
                          const chordScale=R.Cr_vt*12;
                          return(<>
                            <line x1={0} y1={0} x2={x2l} y2={y2l} stroke={C.amber} strokeWidth={2.5} strokeLinecap="round"/>
                            <polygon points={`${x2l},${y2l} ${x2l-chordScale*0.2},${y2l-4} ${x2l+chordScale*0.6},${y2l-4} ${x2l+chordScale*0.4},${y2l}`}
                              fill={C.amber} opacity={0.25} stroke={C.amber} strokeWidth={0.5}/>
                            <line x1={0} y1={0} x2={x2r} y2={y2r} stroke={C.amber} strokeWidth={2.5} strokeLinecap="round"/>
                            <polygon points={`${x2r},${y2r} ${x2r-chordScale*0.6},${y2r-4} ${x2r+chordScale*0.2},${y2r-4} ${x2r-chordScale*0.4},${y2r}`}
                              fill={C.amber} opacity={0.25} stroke={C.amber} strokeWidth={0.5}/>
                            <path d={`M ${28*Math.cos(Math.PI-gr)},${-28*Math.sin(Math.PI-gr)} A 28 28 0 0 1 ${28*Math.cos(gr)},${-28*Math.sin(gr)}`}
                              fill="none" stroke={C.teal} strokeWidth={1} strokeDasharray="3 2"/>
                            <text x={0} y={-31} textAnchor="middle" fill={C.teal} fontSize={10} fontFamily="DM Mono,monospace">Γ={p.vtGamma}°</text>
                            <text x={0} y={-43} textAnchor="middle" fill={C.green} fontSize={9} fontFamily="DM Mono,monospace">opt={R.vtGamma_opt}°</text>
                            <text x={x2l-3} y={y2l-7} textAnchor="middle" fill={C.amber} fontSize={8} fontFamily="DM Mono,monospace">{R.bvt_panel}m</text>
                            <text x={x2r+3} y={y2r-7} textAnchor="middle" fill={C.amber} fontSize={8} fontFamily="DM Mono,monospace">{R.bvt_panel}m</text>
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
                    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>
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
                              <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                              <XAxis dataKey="gamma" tick={{fontSize:10,fill:"#94a3b8"}}
                                label={{value:"Γ (°)",position:"insideBottom",offset:-6,fontSize:11,fill:"#94a3b8"}}/>
                              <YAxis domain={[0,100]} tick={{fontSize:10,fill:"#94a3b8"}}
                                label={{value:"%",angle:-90,position:"insideLeft",offset:8,fontSize:11,fill:"#94a3b8"}}/>
                              <Tooltip {...TTP} formatter={(v,n)=>[`${v}%`,n]}/>
                              <ReferenceLine x={p.vtGamma} stroke={C.amber} strokeDasharray="3 2"
                                label={{value:"Γ",fill:C.amber,fontSize:10,position:"top"}}/>
                              <ReferenceLine x={R.vtGamma_opt} stroke={C.green} strokeDasharray="3 2"
                                label={{value:"opt",fill:C.green,fontSize:10,position:"top"}}/>
                              <ReferenceLine y={50} stroke={C.dim} strokeDasharray="2 2"/>
                              <Line type="monotone" dataKey="pitch" stroke={C.blue} strokeWidth={2} dot={false} name="Pitch cos²Γ"/>
                              <Line type="monotone" dataKey="yaw" stroke={C.red} strokeWidth={2} dot={false} name="Yaw sin²Γ"/>
                              <Legend iconSize={8} wrapperStyle={{fontSize:10,color:"#94a3b8"}}/>
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
                                const Sp=Math.max(R.Sh_req/c2, R.Sv_req/s2);
                                return{gamma:gd, area:+(2*Sp).toFixed(2)};
                              })}
                              margin={{top:4,right:8,left:0,bottom:18}}>
                              <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                              <XAxis dataKey="gamma" tick={{fontSize:10,fill:"#94a3b8"}}
                                label={{value:"Γ (°)",position:"insideBottom",offset:-6,fontSize:11,fill:"#94a3b8"}}/>
                              <YAxis tick={{fontSize:10,fill:"#94a3b8"}}
                                label={{value:"m²",angle:-90,position:"insideLeft",offset:8,fontSize:11,fill:"#94a3b8"}}/>
                              <Tooltip {...TTP} formatter={(v,n)=>[`${v} m²`,n]}/>
                              <ReferenceLine x={p.vtGamma} stroke={C.amber} strokeDasharray="3 2"
                                label={{value:"Γ",fill:C.amber,fontSize:10,position:"top"}}/>
                              <ReferenceLine x={R.vtGamma_opt} stroke={C.green} strokeDasharray="3 2"
                                label={{value:"opt",fill:C.green,fontSize:10,position:"top"}}/>
                              <ReferenceLine y={R.Svt_total} stroke={C.teal} strokeDasharray="3 2"
                                label={{value:"cur",fill:C.teal,fontSize:10,position:"right"}}/>
                              <Line type="monotone" dataKey="area" stroke={C.amber} strokeWidth={2}
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
                    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"12px 14px"}}>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.12em",
                        fontFamily:"'DM Mono',monospace",marginBottom:8,borderBottom:`1px solid ${C.border}`,paddingBottom:5}}>
                        Control Authority vs Requirement
                      </div>
                      <div style={{fontSize:9,color:"#64748b",fontFamily:"'DM Mono',monospace",marginBottom:6,padding:"4px 6px",background:"#0a0d14",borderRadius:4}}>
                        Sh_eff = S_panel·cos²Γ &nbsp;|&nbsp; Sv_eff = S_panel·sin²Γ &nbsp;|&nbsp; Panel sized to governing constraint
                      </div>
                      {[
                        ["Sh_req (pitch needed)",`${R.Sh_req} m²`,"—",C.muted],
                        ["Sv_req (yaw needed)",`${R.Sv_req} m²`,"—",C.muted],
                        ["Panel area (per side)",`${R.Svt_panel} m²`,R.governs_pitch?"↑ pitch governs":"↑ yaw governs",C.amber],
                        ["Sh_eff = S·cos²(Γ)",`${R.Sh_eff} m²`,`${(R.pitch_ratio*100).toFixed(0)}% of req.`,R.pitch_ratio>=1?C.green:C.red],
                        ["Sv_eff = S·sin²(Γ)",`${R.Sv_eff} m²`,`${(R.yaw_ratio*100).toFixed(0)}% of req.`,R.yaw_ratio>=1?C.green:C.red],
                        ["Pitch authority",R.pitch_ratio>=1?"✅ Sufficient":"❌ Insufficient","",R.pitch_ratio>=1?C.green:C.red],
                        ["Yaw authority",R.yaw_ratio>=1?"✅ Sufficient":"❌ Insufficient","",R.yaw_ratio>=1?C.green:C.red],
                        ["Combined authority",`${(R.ruddervator_combined_auth*100).toFixed(0)}%`,"√(p²+y²)",C.teal],
                        ["Updated SM (V-tail NP)",`${(R.SM_vt*100).toFixed(1)}% MAC`,"",R.SM_vt>=0.05&&R.SM_vt<=0.25?C.green:C.red],
                        ["Trim δ ruddervator (pitch)",`${R.delta_rv_deg}°`,"symmetric",C.muted],
                        ["Trim δ ruddervator (yaw)",`${R.delta_yaw_rv_deg}°`,"differential",C.muted],
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
                            const Sh_eff_g=R.Svt_panel*Math.cos(gr)**2;
                            if(Sh_eff_g<0.01) return{gamma:gd,delta:null};
                            const CM_ac=R.selAF?.CM||(-0.02);
                            const de=-(CM_ac*R.Swing*R.MAC)/(0.90*Sh_eff_g*R.lv);
                            const drv=de/Math.cos(gr)*180/Math.PI;
                            return{gamma:gd,delta:+Math.min(Math.max(drv,-35),35).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                          <XAxis dataKey="gamma" tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"Γ (°)",position:"insideBottom",offset:-8,fontSize:10,fill:"#94a3b8"}}/>
                          <YAxis tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:"#94a3b8"}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv pitch"]}/>
                          <ReferenceLine y={20} stroke={C.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:C.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={C.red} strokeDasharray="3 2"/>
                          <ReferenceLine x={p.vtGamma} stroke={C.amber} strokeDasharray="3 2"
                            label={{value:`Γ=${p.vtGamma}°`,fill:C.amber,fontSize:9,position:"top"}}/>
                          <ReferenceLine y={R.delta_rv_deg} stroke={C.green} strokeDasharray="3 2"
                            label={{value:`${R.delta_rv_deg}°`,fill:C.green,fontSize:9,position:"right"}}/>
                          <Line type="monotone" dataKey="delta" stroke={C.blue} strokeWidth={2} dot={false}
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
                            const dyaw=(CY_beta*beta_rad*R.Swing)/(2*R.Sv_eff/R.lv)*180/Math.PI*(-1);
                            return{beta:+beta_deg.toFixed(1),delta:+Math.min(Math.max(dyaw,-30),30).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                          <XAxis dataKey="beta" tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"β (°)",position:"insideBottom",offset:-8,fontSize:10,fill:"#94a3b8"}}/>
                          <YAxis tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:"#94a3b8"}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv yaw"]}/>
                          <ReferenceLine y={20} stroke={C.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:C.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={C.red} strokeDasharray="3 2"/>
                          <ReferenceLine x={0} stroke="#334155" strokeWidth={1}/>
                          <ReferenceLine x={2} stroke={C.amber} strokeDasharray="3 2"
                            label={{value:"β=2°",fill:C.amber,fontSize:9,position:"top"}}/>
                          <ReferenceLine y={R.delta_yaw_rv_deg} stroke={C.green} strokeDasharray="3 2"
                            label={{value:`${R.delta_yaw_rv_deg}°`,fill:C.green,fontSize:9,position:"right"}}/>
                          <Line type="monotone" dataKey="delta" stroke={C.teal} strokeWidth={2} dot={false} name="δ_rv yaw"/>
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
                            const xCG_g=R.xNP-sm*R.MAC;
                            // Pitch moment about AC: CM_ac from airfoil + CL * (xCG-xAC)/MAC
                            const CL_cr=R.Swing>0?2*R.MTOW*9.81/(1.225*p.vCruise**2*R.Swing):1;
                            const CM_ac=R.selAF?.CM||(-0.02);
                            const CM_net=CM_ac+CL_cr*sm;  // net pitch moment
                            const Sh_eff_cur=R.Sh_eff||0.1;
                            const de=-CM_net*R.Swing*R.MAC/(0.90*Sh_eff_cur*R.lv);
                            const drv=de/Math.cos(p.vtGamma*Math.PI/180)*180/Math.PI;
                            return{sm:+sm_pct.toFixed(1),delta:+Math.min(Math.max(drv,-35),35).toFixed(2)};
                          })}
                          margin={{top:4,right:8,left:2,bottom:20}}>
                          <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                          <XAxis dataKey="sm" tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"SM (%)",position:"insideBottom",offset:-8,fontSize:10,fill:"#94a3b8"}}/>
                          <YAxis tick={{fontSize:10,fill:"#94a3b8"}}
                            label={{value:"δ (°)",angle:-90,position:"insideLeft",offset:10,fontSize:10,fill:"#94a3b8"}}/>
                          <Tooltip {...TTP} formatter={(v)=>[`${v}°`,"δ_rv"]}/>
                          <ReferenceLine y={20} stroke={C.red} strokeDasharray="3 2"
                            label={{value:"20° lim",fill:C.red,fontSize:9,position:"right"}}/>
                          <ReferenceLine y={-20} stroke={C.red} strokeDasharray="3 2"/>
                          <ReferenceLine y={0} stroke="#334155" strokeWidth={1}/>
                          <ReferenceLine x={R.SM_vt*100} stroke={C.amber} strokeDasharray="3 2"
                            label={{value:`SM=${(R.SM_vt*100).toFixed(1)}%`,fill:C.amber,fontSize:9,position:"top"}}/>
                          <Line type="monotone" dataKey="delta" stroke={C.green} strokeWidth={2} dot={false} name="δ_rv vs SM"/>
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:18,marginTop:8,padding:"5px 8px",background:"#0a0d14",borderRadius:4,flexWrap:"wrap"}}>
                    {[
                      ["Pitch trim δ_rv",`${R.delta_rv_deg}°`,C.blue,"symmetric, cruise"],
                      ["Yaw trim δ_rv",`${R.delta_yaw_rv_deg}°`,C.teal,"differential, β=2°"],
                      ["Authority limit","±20°","#64748b","CS-23 / FAR 23"],
                      ["Pitch OK",Math.abs(R.delta_rv_deg)<=20?"✅ Within limits":"❌ Exceeds",Math.abs(R.delta_rv_deg)<=20?C.green:C.red,""],
                      ["Yaw OK",Math.abs(R.delta_yaw_rv_deg)<=20?"✅ Within limits":"❌ Exceeds",Math.abs(R.delta_yaw_rv_deg)<=20?C.green:C.red,""],
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
            {tab===8&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10}}>
                  <KPI label="Round 1 MTOW" value={R.MTOW1} unit="kg" color={C.muted}/>
                  <KPI label="Converged MTOW" value={R.MTOW} unit="kg" color={C.green}/>
                  <KPI label="Iterations" value={R.convData.length} unit="" color={C.teal}/>
                </div>
                <Panel title="MTOW Convergence History (Outer Coupled Loop)" h={280}>
                  <ResponsiveContainer width="100%" height={230}>
                    <LineChart data={R.convData} margin={{top:5,right:20,left:-10,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="iter" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Iteration",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"MTOW (kg)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP}/>
                      <Line type="monotone" dataKey="MTOW" stroke={C.amber} strokeWidth={2} dot={{r:3,fill:C.amber}} name="MTOW (kg)"/>
                      <ReferenceLine y={R.MTOW} stroke={C.green} strokeDasharray="4 3" label={{value:"Converged",fill:C.green,fontSize:11}}/>
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
                <Panel title="Energy Convergence History" h={255}>
                  <ResponsiveContainer width="100%" height={205}>
                    <LineChart data={R.convData.filter(d=>d.Energy!=null)} margin={{top:5,right:20,left:-10,bottom:0}}>
                      <CartesianGrid strokeDasharray="2 2" stroke={C.border}/>
                      <XAxis dataKey="iter" tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Iteration",position:"insideBottom",fontSize:12,fill:"#94a3b8"}}/>
                      <YAxis tick={{fontSize:11,fill:"#94a3b8"}} label={{value:"Total Energy (kWh)",angle:-90,position:"insideLeft",fontSize:12,fill:"#94a3b8"}}/>
                      <Tooltip {...TTP}/>
                      <Line type="monotone" dataKey="Energy" stroke={C.teal} strokeWidth={2} dot={{r:3,fill:C.teal}} name="Energy (kWh)"/>
                      <ReferenceLine y={R.Etot} stroke={C.green} strokeDasharray="4 3" label={{value:"Converged",fill:C.green,fontSize:11}}/>
                    </LineChart>
                  </ResponsiveContainer>
                </Panel>
                <Panel title="Final Converged Design Summary — All Sections">
                  <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>
                    {[["MTOW",`${R.MTOW} kg`,C.amber],["Empty Wt",`${R.Wempty} kg`,C.amber],
                      ["Battery",`${R.Wbat} kg`,C.amber],["Payload",`${p.payload} kg`,C.amber],
                      ["Hover Pwr",`${R.Phov} kW`,C.blue],["Climb Pwr",`${R.Pcl} kW`,C.blue],
                      ["Cruise Pwr",`${R.Pcr} kW`,C.blue],["Total E",`${R.Etot} kWh`,C.teal],
                      ["Pack E",`${R.PackkWh} kWh`,C.teal],["Wing Area",`${R.Swing} m²`,C.green],
                      ["Wing Span",`${R.bWing} m`,C.green],["MAC",`${R.MAC} m`,C.green],
                      ["Actual L/D",R.LDact,C.green],["Airfoil",R.selAF.name,C.green],
                      ["Vstall",`${R.Vstall} m/s`,"#8b5cf6"],["Va",`${R.VA} m/s`,"#8b5cf6"],
                      ["Rotor Diam",`${R.Drotor} m`,"#f97316"],["Tip Mach",R.TipMach,"#f97316"],
                      ["SM",`${(R.SM*100).toFixed(1)}%`,R.SM>0.05&&R.SM<0.25?C.green:C.red],
                      ["Mach",R.Mach,R.Mach<0.45?C.green:C.amber],
                    ].map(([k,v,col],i)=>(
                      <div key={i} style={{background:C.bg,borderRadius:4,padding:"6px 8px",borderLeft:`2px solid ${col}44`}}>
                        <div style={{fontSize:7,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:1}}>{k}</div>
                        <div style={{fontSize:10,color:col,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              </div>
            )}

            {/* ──── TAB 9: OPENVSP EXPORT ──── */}
            {tab===9&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* Header banner */}
                <div style={{background:"linear-gradient(135deg,#0d1117 0%,#0f172a 100%)",
                  border:`1px solid ${C.border}`,borderRadius:8,padding:"16px 20px",
                  display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.15em",marginBottom:4}}>GEOMETRY EXPORT</div>
                    <div style={{fontSize:22,fontWeight:800,color:C.amber,letterSpacing:"-0.03em"}}>OpenVSP Script Generator</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2,fontFamily:"'DM Mono',monospace"}}>
                      Generates a .vspscript that builds fuselage · wing · V-tail · {p.nPropHover} hover rotors · CG & NP  inside your OpenVSP
                    </div>
                  </div>
                  <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                    <button
                      onClick={()=>{
                        const xml=generateVSPScript(p,R);
                        const blob=new Blob([xml],{type:"text/plain"});
                        const url=URL.createObjectURL(blob);
                        const a=document.createElement("a");
                        a.href=url; a.download="Trail1_eVTOL.vspscript"; a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={{padding:"10px 22px",background:`linear-gradient(135deg,${C.amber},#f97316)`,
                        border:"none",borderRadius:6,color:"#07090f",fontSize:13,fontWeight:800,
                        cursor:"pointer",letterSpacing:"0.05em",fontFamily:"'DM Mono',monospace",
                        boxShadow:`0 0 20px ${C.amber}55`}}>
                      ⬇  Download .vspscript
                    </button>
                  </div>
                </div>

                {/* Geometry summary cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                  {[
                    ["Fuselage","Body","L "+p.fusLen+" m  Ø "+p.fusDiam+" m","#64748b"],
                    ["Main Wing","WING_GEOM","S="+R.Swing+" m²  b="+R.bWing+" m","#3b82f6"],
                    ["V-Tail","WING_GEOM","Γ="+p.vtGamma+"°  S="+R.Svt_total.toFixed(2)+" m²","#8b5cf6"],
                    ["Hover Rotors","PROP_GEOM × "+p.nPropHover,"D="+R.Drotor+" m  "+R.Nbld+" blades","#22c55e"],
                    ["CG + NP","Markers","CG="+R.xCGtotal+"m  NP="+R.xNP+"m","#f59e0b"],
                  ].map(([title,type,detail,col])=>(
                    <div key={title} style={{background:C.panel,border:`1px solid ${col}33`,
                      borderLeft:`3px solid ${col}`,borderRadius:6,padding:"10px 12px"}}>
                      <div style={{fontSize:11,fontWeight:700,color:col,fontFamily:"'DM Mono',monospace",marginBottom:3}}>{title}</div>
                      <div style={{fontSize:8,color:C.muted,fontFamily:"'DM Mono',monospace",marginBottom:4}}>{type}</div>
                      <div style={{fontSize:9,color:C.text,fontFamily:"'DM Mono',monospace"}}>{detail}</div>
                    </div>
                  ))}
                </div>

                {/* Two-column: geometry table + coordinate diagram */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                  <Panel title="Geometry Placement — OpenVSP Coordinates (X: nose→tail, Y: port→stbd, Z: up)">
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:"'DM Mono',monospace"}}>
                      <thead>
                        <tr style={{borderBottom:`1px solid ${C.border}`}}>
                          {["Component","x_LE (m)","y (m)","z (m)","Dihedral"].map(h=>(
                            <th key={h} style={{textAlign:"left",padding:"3px 6px",fontSize:8,color:C.muted,
                              textTransform:"uppercase",letterSpacing:"0.08em"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(()=>{
                          const xWingLE_=(R.xACwing-0.25*R.Cr_).toFixed(3);
                          const zWing_=(-p.fusDiam*0.10).toFixed(3);
                          const xVtLE_=((R.xACwing+R.lv)-0.25*R.MAC_vt).toFixed(3);
                          const zVt_=(p.fusDiam*0.05).toFixed(3);
                          const nSide=Math.floor(p.nPropHover/2);
                          const rows=[
                            ["Fuselage","0.000","0.000","0.000","0°"],
                            ["Main Wing",xWingLE_,"0.000 (root)",zWing_,"2° (low-wing)"],
                            ["V-Tail",xVtLE_,"0.000 (root)",zVt_,p.vtGamma+"° (panel)"],
                            ...Array.from({length:nSide},(_,i)=>{
                              const y=((R.bWing/2)*(i+0.5)/nSide).toFixed(3);
                              const x=((R.xACwing-0.25*R.Cr_)-0.30).toFixed(3);
                              const z=((-p.fusDiam*0.10)+R.Drotor*0.55).toFixed(3);
                              return["Rotor "+(2*i)+" / "+(2*i+1),x,"±"+y,z,"—"];
                            }),
                            ["CG Marker",R.xCGtotal.toFixed(3),"0","fD×0.55","—"],
                            ["NP Marker",R.xNP.toFixed(3),"0","fD×0.65","—"],
                          ];
                          return rows.map((r,i)=>(
                            <tr key={i} style={{background:i%2===0?C.bg:"transparent",
                              borderBottom:`1px solid ${C.border}22`}}>
                              {r.map((cell,j)=>(
                                <td key={j} style={{padding:"4px 6px",
                                  color:j===0?C.amber:C.text,
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
                        {indent:0,icon:"🏗️",label:"Fuselage (FUSELAGE_GEOM)",detail:`L=${p.fusLen}m  Ø=${p.fusDiam}m`,col:"#94a3b8"},
                        {indent:1,icon:"✈️",label:"Main Wing (WING_GEOM)",detail:`b=${R.bWing}m  S=${R.Swing}m²  AR=${p.AR}  λ=${p.taper}`,col:C.blue},
                        {indent:1,icon:"🦋",label:"V-Tail (WING_GEOM · XZ sym)",detail:`Γ=${p.vtGamma}°  S_panel=${R.Svt_panel}m²  AR=${p.vtAR}`,col:"#8b5cf6"},
                        {indent:1,icon:"🟢",label:"CG Marker (FUSELAGE_GEOM)",detail:`x=${R.xCGtotal}m  SM=${((R.SM)*100).toFixed(1)}% MAC`,col:C.green},
                        {indent:1,icon:"🔵",label:"NP Marker (FUSELAGE_GEOM)",detail:`x=${R.xNP}m from nose`,col:C.teal},
                        ...Array.from({length:Math.floor(p.nPropHover/2)},(_,i)=>({
                          indent:1,icon:"🔧",
                          label:`Rotor pair ${i} (PROP_GEOM × 2)`,
                          detail:`D=${R.Drotor}m  ${R.Nbld||3} blades  @y=±${((R.bWing/2)*(i+0.5)/Math.floor(p.nPropHover/2)).toFixed(2)}m`,
                          col:C.amber,
                        })),
                      ].map((n,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"flex-start",gap:4,
                          paddingLeft:n.indent*18,paddingTop:1,paddingBottom:1}}>
                          <span style={{color:C.dim,flexShrink:0}}>{n.indent>0?"└ ":""}</span>
                          <span style={{flexShrink:0}}>{n.icon}</span>
                          <div>
                            <span style={{color:n.col,fontWeight:600}}>{n.label}</span>
                            <div style={{fontSize:8,color:C.muted,marginTop:1}}>{n.detail}</div>
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
                        ["MTOW",R.MTOW+" kg"],
                        ["Wing LE (from nose)",(R.xACwing-0.25*R.Cr_).toFixed(3)+" m"],
                        ["Wing root chord",R.Cr_+" m"],
                        ["Wing tip chord",R.Ct_+" m"],
                        ["Wing half-span",(R.bWing/2).toFixed(3)+" m"],
                        ["Wing sweep (LE)",R.sweep+"°"],
                        ["Wing t/c",p.tc],
                        ["V-tail root LE",((R.xACwing+R.lv)-0.25*R.MAC_vt).toFixed(3)+" m"],
                        ["V-tail panel span",R.bvt_panel+" m"],
                        ["V-tail root chord",R.Cr_vt+" m"],
                        ["V-tail sweep (LE)",R.sweep_vt+"°"],
                        ["Rotor diameter",R.Drotor+" m"],
                        ["Blade chord",R.ChordBl.toFixed(4)+" m"],
                        ["CG from nose",R.xCGtotal+" m"],
                        ["NP from nose",R.xNP+" m"],
                        ["Static margin",(R.SM*100).toFixed(1)+"% MAC"],
                      ].map(([k,v])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",
                          padding:"3px 6px",background:C.bg,borderRadius:3}}>
                          <span style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace"}}>{k}</span>
                          <span style={{fontSize:9,color:C.amber,fontFamily:"'DM Mono',monospace",fontWeight:700}}>{v}</span>
                        </div>
                      ))}
                    </div>
                  </Panel>

                  <Panel title="How to Run the .vspscript in OpenVSP 3.48">
                    {[
                      ["1","Download","Click Download above — saves Trail1_eVTOL.vspscript to your computer."],
                      ["2","Open","Open OpenVSP 3.28+ (incl. 3.48.2) — go to  File → Run Script  (or Ctrl+Shift+S)."],
                      ["3","Inspect","Browse to Trail1_eVTOL.vspscript and click  Execute. Model builds in seconds."],
                      ["4","CG / NP","File is auto-saved as Trail1_eVTOL.vsp3 in your OpenVSP working directory."],
                      ["5","Rotors","Rotors use Y_Rot=−90° → disk horizontal → thrust +Z. Use Analysis Manager to adjust blade pitch."],
                      ["6","V-Tail","V-tail uses XZ symmetry + dihedral Γ for both panels. CG/NP are set as vehicle mass properties."],
                      ["7","Iterate","Slider change in sidebar → re-download → re-run script. Each run rebuilds the model exactly."],
                    ].map(([n,title,text])=>(
                      <div key={n} style={{display:"flex",gap:8,marginBottom:8}}>
                        <div style={{width:18,height:18,borderRadius:"50%",background:C.amber,flexShrink:0,
                          display:"flex",alignItems:"center",justifyContent:"center",
                          fontSize:8,fontWeight:800,color:"#07090f",fontFamily:"'DM Mono',monospace"}}>{n}</div>
                        <div>
                          <div style={{fontSize:10,fontWeight:700,color:C.text,fontFamily:"'DM Mono',monospace"}}>{title}</div>
                          <div style={{fontSize:9,color:C.muted,marginTop:1,lineHeight:1.5}}>{text}</div>
                        </div>
                      </div>
                    ))}
                  </Panel>
                </div>

                {/* Second download button at bottom */}
                <div style={{display:"flex",justifyContent:"center",paddingTop:4,paddingBottom:8}}>
                  <button
                    onClick={()=>{
                      const xml=generateVSPScript(p,R);
                      const blob=new Blob([xml],{type:"application/xml"});
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url; a.download="Trail1_eVTOL.vspscript"; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{padding:"12px 40px",background:`linear-gradient(135deg,${C.amber},#f97316)`,
                      border:"none",borderRadius:6,color:"#07090f",fontSize:14,fontWeight:800,
                      cursor:"pointer",letterSpacing:"0.06em",fontFamily:"'DM Mono',monospace",
                      boxShadow:`0 0 30px ${C.amber}44`}}>
                    ⬇  Download Trail1_eVTOL.vspscript
                  </button>
                </div>
              </div>
            )}

            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
