import { useState, useMemo, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, RadarChart, Radar,
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
  const sweep=Math.atan((Cr_-Ct_)/bWing)*180/Math.PI;
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
  const Swf=Math.PI*fD*fL*Math.pow(1-2/fL,2/3)*(1+1/(fL/fD)**2);
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
  const xCGfus=fL*0.42,xCGwing=1.45+Xac,xCGbat=fL*0.38,xCGpay=fL*0.40;
  const Wfusc=Wempty*0.35,Wwingc=Wempty*0.18,Wmotc=Wempty*0.22,Wavc=Wempty*0.04,Wothc=Wempty*0.21;
  const xCGempty=(Wfusc*xCGfus+Wwingc*xCGwing+Wmotc*xCGfus+Wavc*0.8+Wothc*xCGfus)/Wempty;
  const xCGtotal=(Wempty*xCGempty+Wbat*xCGbat+p.payload*xCGpay)/MTOW;
  const xACwing=1.45+Xac,lh=fL-xACwing,Sh=Swing*0.18;
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
  const lv=fL-xACwing;  // tail moment arm ≈ fuselage length - wing AC
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
  const sweep_vt=Math.atan((Cr_vt-Ct_vt)/bvt_panel)*180/Math.PI;

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
  const N=200,powerSteps=[],socSteps=[],velSteps=[];
  for(let i=0;i<=N;i++){
    const t=Tend*i/N;
    let ph=5; for(let j=0;j<6;j++)if(t>=tPhases[j]&&t<tPhases[j+1]){ph=j;break;}
    const Ec=Ecum_ph[ph]+phPow[ph]*((t-tPhases[ph])/3600);
    const socFloor=p.socMin/(1+p.socMin);  // true floor = SoCmin/(1+SoCmin)
    const soc=Math.max(socFloor,(1-Ec/PackkWh))*100;
    powerSteps.push({t:+t.toFixed(0),P:+phPow[ph].toFixed(1),ph:["TO","Climb","Cruise","Desc","Land","Res"][ph]});
    socSteps.push({t:+t.toFixed(0),SoC:+soc.toFixed(2)});
    velSteps.push({t:+t.toFixed(0),V:+phV[ph].toFixed(1)});
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
    SM:+SM.toFixed(4),xCGtotal:+xCGtotal.toFixed(3),xNP:+xNP.toFixed(3),
    Drotor:+Drotor.toFixed(3),DLrotor:+DLrotor.toFixed(1),PLrotor:+PLrotor.toFixed(1),
    TipSpd:+TipSpd.toFixed(1),TipMach:+TipMach.toFixed(4),RPM:+RPM.toFixed(0),
    ChordBl:+ChordBl.toFixed(4),BladeAR:+BladeAR.toFixed(2),Nbld,PmotKW:+PmotKW.toFixed(2),
    PpeakKW:+PpeakKW.toFixed(2),Torque:+Torque.toFixed(1),MotMass:+MotMass.toFixed(2),
    SEDpack:+SEDpack.toFixed(1),Nseries,Npar,Ncells,PackV:+PackV.toFixed(0),PackAh:+PackAh.toFixed(1),
    PackkWh:+PackkWh.toFixed(3),CrateHov:+CrateHov.toFixed(2),CrateCr:+CrateCr.toFixed(2),Pheat:+Pheat.toFixed(1),
    Vstall:+Vstall.toFixed(2),VA:+VA.toFixed(2),VD:+VD.toFixed(2),
    vnData,rpData,polarData,powerSteps,socSteps,velSteps,convData,weightBreak,dragComp,tPhases,
    checks,feasible:checks.every(c=>c.ok),
    vtGamma_opt:+vtGamma_opt_deg.toFixed(1),Svt_total:+Svt_total.toFixed(3),Svt_panel:+Svt_panel.toFixed(3),governs_pitch:Svt_panel_pitch>=Svt_panel_yaw,ruddervator_combined_auth:+ruddervator_combined_auth.toFixed(3),delta_yaw_rv_deg:+delta_yaw_rv_deg.toFixed(2),
    Sh_req:+Sh_req.toFixed(3),Sv_req:+Sv_req.toFixed(3),Sh_eff:+Sh_eff.toFixed(3),Sv_eff:+Sv_eff.toFixed(3),
    pitch_ratio:+pitch_ratio.toFixed(3),yaw_ratio:+yaw_ratio.toFixed(3),
    bvt_panel:+bvt_panel.toFixed(3),Cr_vt:+Cr_vt.toFixed(3),Ct_vt:+Ct_vt.toFixed(3),MAC_vt:+MAC_vt.toFixed(3),
    sweep_vt:+sweep_vt.toFixed(2),Srv:+Srv.toFixed(3),Wvt_total:+Wvt_total.toFixed(1),
    CD0vt:+CD0vt.toFixed(6),SM_vt:+SM_vt.toFixed(4),delta_rv_deg:+delta_rv_deg.toFixed(2),
    lv:+lv.toFixed(3),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   OPENVSP FILE GENERATOR  —  produces a valid .vsp3 XML file
   Format: OpenVSP 3.35+ (compatible with 3.48.2)
   Coordinate convention: X = nose→tail, Y = port→stbd, Z = up
   Trail 1 Layout:
     • Fuselage (parent of all children)
     • Main Wing  (XZ symmetric)
     • V-Tail     (XZ symmetric, dihedral)
     • 4 Wingtip Tilt-Rotors  (PROP_GEOM, Y=±bWing/2)
     • 4 Fixed Lift-Rotors    (PROP_GEOM, on fuselage struts)
     • 1 Tail Pusher          (PROP_GEOM, horizontal at tail)
     • CG & NP markers
   Key fixes vs old version:
     • Parm format: val="" attribute (NOT <real>/<int> child nodes)
     • <ParentGeom> not <Parent>; <ChildIDVec> not <Children>
     • <GeomVec> in Vehicle (not <Geom_ID_List>); no <Geom_Container>
     • xACwing recomputed from R.Xac (not destructured—not in R)
   ═══════════════════════════════════════════════════════════════════════ */
function generateVSPFile(p,R,tiltAngle=90){
  /* ── deterministic 8-char ID ── */
  function mkID(seed){
    const C='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let h=0x811c9dc5>>>0;
    for(let i=0;i<seed.length;i++){h^=seed.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}
    let id='';
    for(let i=0;i<8;i++){id+=C[h%C.length];h=Math.imul(h,6364136223)>>>0;}
    return id;
  }

  /* ── component IDs ── */
  const FUS_ID  = mkID('trail1_fuse');
  const WNG_ID  = mkID('trail1_wing');
  const VTL_ID  = mkID('trail1_vtail');
  const CGM_ID  = mkID('trail1_cgmrk');
  const NPM_ID  = mkID('trail1_npmrk');
  const PUS_ID  = mkID('trail1_pusher');
  // TRAIL 1: 1 tilt-rotor per wingtip (0°=cruise forward / 90°=hover up) = 2
  const WT_IDS  = [mkID('wtr_port'),mkID('wtr_stbd')];
  // 2 boom-mounted lift rotors per side (fore + aft on horizontal booms at mid-wing Y) = 4
  const FX_IDS  = [mkID('fxr_pf'),mkID('fxr_pa'),mkID('fxr_sf'),mkID('fxr_sa')];

  /* ── extracted values (FIX: xACwing not in R; recompute from R.Xac) ── */
  const fL=p.fusLen, fD=p.fusDiam;
  const{bWing,Cr_,Ct_,sweep,Xac,Swing,
    bvt_panel,Cr_vt,Ct_vt,sweep_vt,lv,Svt_total,MAC_vt,
    Drotor,xCGtotal,xNP,MTOW,Nbld,ChordBl}=R;
  const xACwing = 1.45 + Xac;   // recomputed — matches runSizing definition

  /* ── positions ── */
  const xWingLE = xACwing - 0.25*Cr_;
  const zWing   = -fD*0.10;
  const xVtLE   = (xACwing+lv) - 0.25*MAC_vt;
  const zVtail  = fD*0.05;

  /* ── Trail 1 PRECISE Rotor Positions ─────────────────────────────────
     Coordinate system: X=nose→tail, Y=port→stbd (right), Z=up
     All positions derived from wing sizing outputs (bWing, Cr_, Drotor, etc.)

     WINGTIP TILT ROTORS (1 per tip):
       • Y = ±bWing/2  (at physical wingtip)
       • X = xWingLE + Cr_*0.5  (mid-chord of tip — balanced tilt axis)
       • Z = zWing + Drotor*0.55  (hub clears wing surface by ~half radius)
       • Y_Rel_Rotation = -(tiltAngle)  [0°=cruise(fwd), 90°=hover(up)]

     BOOM LIFT ROTORS (2 per side, on horizontal booms):
       • Y = ±bWing*0.28  (mid-wing: ~28% of full span = 56% of semi-span)
         → Derived from p.nPropHover and bWing so spacing is aerodynamically valid
       • Fore rotor:  X = xWingLE - Drotor*0.60  (forward boom, clears wing LE)
       • Aft  rotor:  X = xWingLE + Cr_ + Drotor*0.35  (aft boom, clears wing TE)
       • Z = fD*0.30  (boom at mid-fuselage height, rotors above)
       • Y_Rel_Rotation = -90  (always vertical thrust)

     TAIL PUSHER (1, centreline):
       • X = fL - Drotor*0.25  (at tail, disc forward of trailing edge)
       • Y = 0, Z = fD*0.05 (on fuselage centreline)
       • Y_Rel_Rotation = 0  (horizontal, pushing aft → +X thrust)
  ────────────────────────────────────────────────────────────────────── */

  // Mid-wing Y for boom rotors — taken from bWing calculation output
  const yBoom = bWing * 0.28;
  const zBoom = fD * 0.30;

  // Wingtip tilt rotor positions (1 per tip)
  const tiltRY = -(tiltAngle);   // 0=cruise, -90=hover
  const ytip   = bWing / 2;
  const xtilt  = xWingLE + Cr_ * 0.50;
  const ztilt  = zWing + Drotor * 0.55;
  const wtRotPos = [
    {id:WT_IDS[0], x:xtilt, y:+ytip, z:ztilt, ry:tiltRY, label:'TiltRotor_PORT'},
    {id:WT_IDS[1], x:xtilt, y:-ytip, z:ztilt, ry:tiltRY, label:'TiltRotor_STBD'},
  ];

  // Boom-mounted lift rotor positions (2 fore+aft per side)
  const xBoomFore = xWingLE - Drotor * 0.60;   // forward of wing LE
  const xBoomAft  = xWingLE + Cr_ + Drotor * 0.35; // aft of wing TE
  const fxDiam    = Drotor * 0.72;  // boom rotors slightly smaller than tip rotor
  const fxRotPos  = [
    {id:FX_IDS[0], x:xBoomFore, y:+yBoom, z:zBoom, ry:-90, label:'BoomRotor_PORT_FWD'},
    {id:FX_IDS[1], x:xBoomAft,  y:+yBoom, z:zBoom, ry:-90, label:'BoomRotor_PORT_AFT'},
    {id:FX_IDS[2], x:xBoomFore, y:-yBoom, z:zBoom, ry:-90, label:'BoomRotor_STBD_FWD'},
    {id:FX_IDS[3], x:xBoomAft,  y:-yBoom, z:zBoom, ry:-90, label:'BoomRotor_STBD_AFT'},
  ];

  // Tail pusher
  const pusherPos = {id:PUS_ID, x:fL - Drotor*0.25, y:0, z:fD*0.05};

  /* ═══════════════════════════════════════════════════
     XML HELPERS  — OpenVSP 3.35+ format
     CRITICAL FIX: Parms use val="" attribute, NOT <real>/<int> child nodes
     ═══════════════════════════════════════════════════ */
  const f=(v,d=6)=>Number(v).toFixed(d);
  const P=(nm,grp,val,isInt=false)=>
    `<Parm name="${nm}" group="${grp}" type="${isInt?3:6}" val="${isInt?Math.round(val):f(val)}"/>`;

  const SYM=(pf=0)=>[
    P('SymPlanFlag','Sym',pf,true),
    P('SymAxFlag',  'Sym',0,  true),
    P('SymRotN',    'Sym',2,  true),
  ].join('\n        ');

  const XFORM=(x,y,z,rx=0,ry=0,rz=0)=>[
    P('X_Rel_Location','XForm',x),
    P('Y_Rel_Location','XForm',y),
    P('Z_Rel_Location','XForm',z),
    P('X_Rel_Rotation','XForm',rx),
    P('Y_Rel_Rotation','XForm',ry),
    P('Z_Rel_Rotation','XForm',rz),
    P('Origin','XForm',0),
  ].join('\n        ');

  // Geom ParmContainer (Sym + XForm)
  const HDR=(name,id,planFlag,x,y,z,rx=0,ry=0,rz=0)=>
`    <ParmContainer name="${name}" id="${id}">
        ${SYM(planFlag)}
        ${XFORM(x,y,z,rx,ry,rz)}
    </ParmContainer>`;

  /* ═══════════════════════════════════════════════════
     FUSELAGE  — 9 cross-sections
     ═══════════════════════════════════════════════════ */
  const cs=[
    [0.000, 0,       0      ],
    [0.030, fD*0.38, fD*0.38],
    [0.090, fD*0.90, fD*0.90],
    [0.250, fD,      fD     ],
    [0.480, fD,      fD     ],
    [0.650, fD*0.98, fD*0.95],
    [0.800, fD*0.80, fD*0.75],
    [0.920, fD*0.48, fD*0.38],
    [1.000, fD*0.16, fD*0.10],
  ];
  function mkXSec(idx,[u,w,h]){
    const isPt=w<0.005, ctype=isPt?0:3;
    const cParms=isPt?'':`
              ${P('Super_Height','SuperEllipse',h)}
              ${P('Super_Width', 'SuperEllipse',w)}
              ${P('Super_M',     'SuperEllipse',2.0)}
              ${P('Super_N',     'SuperEllipse',2.0)}
              ${P('Super_M_Bot', 'SuperEllipse',2.0)}
              ${P('Super_N_Bot', 'SuperEllipse',2.0)}
              ${P('Super_Toggle','SuperEllipse',1,true)}`;
    return `
        <XSec type="0">
          <ParmContainer name="XSec_${idx}" id="${mkID('xs'+idx+'f')}">
            ${P('XLocPercent','XSec',u)}
            ${P('YLocPercent','XSec',0)}
            ${P('ZLocPercent','XSec',0)}
            ${P('XRot','XSec',0)}
            ${P('YRot','XSec',0)}
            ${P('ZRot','XSec',0)}
            ${P('RefLength','XSec',fL)}
            ${P('Tan_Str_1','XSec',0.5)}
            ${P('Tan_Str_2','XSec',0.5)}
          </ParmContainer>
          <XSecCurve type="${ctype}">
            <ParmContainer name="XSecCurve_${idx}" id="${mkID('xsc'+idx+'f')}">${cParms}
            </ParmContainer>
          </XSecCurve>
        </XSec>`;
  }

  const allChildIDs=[WNG_ID,VTL_ID,CGM_ID,NPM_ID,PUS_ID,
    ...WT_IDS,...FX_IDS].map(id=>`      <string>${id}</string>`).join('\n');

  const fusGeom=`
  <!-- ═══ FUSELAGE ═══ -->
  <Geom type="FUSELAGE_GEOM">
${HDR('Fuselage',FUS_ID,0,0,0,0)}
    <ParentGeom>NONE</ParentGeom>
    <ChildIDVec>
${allChildIDs}
    </ChildIDVec>
    <FuselageGeom>
      <ParmContainer name="FuselageGeom" id="${mkID('fusegeo')}">
        ${P('Length',      'Design',fL)}
        ${P('OrderPolicy', 'Design',0,true)}
        ${P('NumU_Mult',   'Design',1,true)}
      </ParmContainer>
      <XSecSurf id="${mkID('xsurf')}">
        <ParmContainer name="XSecSurf" id="${mkID('xsurfpc')}">
          ${P('TESS_W','Tesselation',12,true)}
          ${P('TESS_U','Tesselation',20,true)}
        </ParmContainer>
${cs.map((c,i)=>mkXSec(i,c)).join('')}
      </XSecSurf>
    </FuselageGeom>
  </Geom>`;

  /* ═══════════════════════════════════════════════════
     WING SECTION helper
     ═══════════════════════════════════════════════════ */
  function mkWingSect(key,span,rc,tc,swDeg,dihedDeg,thk){
    return`
        <WingSect>
          <ParmContainer name="WingSection" id="${mkID(key)}">
            ${P('Span',       'WingSection',span)}
            ${P('Rc',         'WingSection',rc)}
            ${P('Tc',         'WingSection',tc)}
            ${P('Sweep',      'WingSection',swDeg)}
            ${P('SweepLoc',   'WingSection',0)}
            ${P('Dihedral',   'WingSection',dihedDeg)}
            ${P('Twist',      'WingSection',0)}
            ${P('TwistLoc',   'WingSection',0.25)}
            ${P('Camber',     'WingSection',0.02)}
            ${P('CamberLoc',  'WingSection',0.40)}
            ${P('Thickness',  'WingSection',thk)}
            ${P('NumSpanSeg', 'WingSection',8,true)}
            ${P('NumChordSeg','WingSection',8,true)}
          </ParmContainer>
        </WingSect>`;
  }

  /* ═══════════════════════════════════════════════════
     MAIN WING
     ═══════════════════════════════════════════════════ */
  const mainWingGeom=`
  <!-- ═══ MAIN WING ═══ -->
  <Geom type="WING_GEOM">
${HDR('MainWing',WNG_ID,2,xWingLE,0,zWing)}
    <ParentGeom>${FUS_ID}</ParentGeom>
    <ChildIDVec/>
    <WingGeom>
      <ParmContainer name="WingGeom" id="${mkID('wgmain')}">
        ${P('TotalSpan', 'Design',bWing)}
        ${P('TotalArea', 'Design',Swing)}
        ${P('TotalAR',   'Design',p.AR)}
        ${P('TotalTaper','Design',p.taper)}
        ${P('TotalSweep','Design',sweep)}
        ${P('SweepLoc',  'Design',0)}
        ${P('Dihedral',  'Design',2)}
        ${P('NumU_Mult', 'Design',1,true)}
        ${P('NumW_Mult', 'Design',1,true)}
      </ParmContainer>
      <SectionList>
${mkWingSect('ws_main',bWing/2,Cr_,Ct_,sweep,2,p.tc)}
      </SectionList>
    </WingGeom>
  </Geom>`;

  /* ═══════════════════════════════════════════════════
     V-TAIL  (XZ sym → both ruddervator panels)
     ═══════════════════════════════════════════════════ */
  const vtailGeom=`
  <!-- ═══ V-TAIL ═══ -->
  <Geom type="WING_GEOM">
${HDR('VTail',VTL_ID,2,xVtLE,0,zVtail)}
    <ParentGeom>${FUS_ID}</ParentGeom>
    <ChildIDVec/>
    <WingGeom>
      <ParmContainer name="WingGeom" id="${mkID('wgvtail')}">
        ${P('TotalSpan', 'Design',bvt_panel*2)}
        ${P('TotalArea', 'Design',Svt_total)}
        ${P('TotalAR',   'Design',p.vtAR)}
        ${P('TotalTaper','Design',0.4)}
        ${P('TotalSweep','Design',sweep_vt)}
        ${P('SweepLoc',  'Design',0)}
        ${P('Dihedral',  'Design',p.vtGamma)}
        ${P('NumU_Mult', 'Design',1,true)}
        ${P('NumW_Mult', 'Design',1,true)}
      </ParmContainer>
      <SectionList>
${mkWingSect('ws_vtail',bvt_panel,Cr_vt,Ct_vt,sweep_vt,p.vtGamma,0.09)}
      </SectionList>
    </WingGeom>
  </Geom>`;

  /* ═══════════════════════════════════════════════════
     PROP helper — blade sections
     ═══════════════════════════════════════════════════ */
  function mkPropSect(key,rFrac,chord,twist){
    return`
          <PropBladeXSec>
            <ParmContainer name="PropBladeXSec" id="${mkID(key)}">
              ${P('RadFrac',  'PropBladeSect',rFrac)}
              ${P('Chord',    'PropBladeSect',chord)}
              ${P('Twist',    'PropBladeSect',twist)}
              ${P('Rake',     'PropBladeSect',0)}
              ${P('Skew',     'PropBladeSect',0)}
              ${P('Sweep',    'PropBladeSect',0)}
              ${P('Thickness','PropBladeSect',0.12)}
            </ParmContainer>
          </PropBladeXSec>`;
  }

  function mkProp(label,id,x,y,z,ry,diam,nb,chord){
    return`
  <!-- ═══ ${label} ═══ -->
  <Geom type="PROP_GEOM">
${HDR(label,id,0,x,y,z,0,ry,0)}
    <ParentGeom>${FUS_ID}</ParentGeom>
    <ChildIDVec/>
    <PropGeom>
      <ParmContainer name="PropGeom" id="${mkID('pg_'+label)}">
        ${P('Diameter',        'Design',diam)}
        ${P('Nblade',          'Design',nb||3,true)}
        ${P('Precone',         'Design',0)}
        ${P('Beta34',          'Design',22)}
        ${P('Feather',         'Design',0)}
        ${P('FeatherOffset',   'Design',0.25)}
        ${P('FeatherAxis',     'Design',0.25)}
        ${P('ZeroDeltaTheta',  'Design',0,true)}
        ${P('UseBeta34Flag',   'Design',1,true)}
        ${P('HubDiameter',     'Design',diam*0.12)}
        ${P('CLi',             'Design',0.5)}
        ${P('AF_Limit',        'Design',0.20)}
        ${P('RFold',           'Design',1.0)}
        ${P('ThetaFold',       'Design',0)}
        ${P('AzimuthOffset',   'Design',0)}
        ${P('r_Fold_Location', 'Design',0.85)}
        ${P('Delta_Theta_Fold','Design',180)}
        ${P('MultiRotorDisk',  'Design',0,true)}
        ${P('AxialVel',        'Design',0)}
        ${P('TangentialVel',   'Design',0)}
      </ParmContainer>
      <BladeList>
        <PropBlade>
          <ParmContainer name="PropBlade_0" id="${mkID('pbl_'+label)}">
            ${P('NumU','PropBlade',3,true)}
          </ParmContainer>
          <SectionList>
${mkPropSect('pb0_'+label,0.20,chord*1.15,32)}
${mkPropSect('pb1_'+label,0.65,chord,22)}
${mkPropSect('pb2_'+label,1.00,chord*0.65,14)}
          </SectionList>
        </PropBlade>
      </BladeList>
    </PropGeom>
  </Geom>`;
  }

  /* ═══════════════════════════════════════════════════
     TRAIL 1 ROTOR LAYOUT — 7 propulsors total
     2 Wingtip Tilt Rotors  → tilt angle set by user (0°=cruise, 90°=hover)
     4 Boom Lift Rotors     → always vertical (rY=-90)
     1 Tail Pusher          → always horizontal (rY=0)
     ═══════════════════════════════════════════════════ */
  const nb=Nbld||3, cb=ChordBl;

  // 2 wingtip tilt-rotors (full-size Drotor, tilt angle from slider)
  const wtGeoms=wtRotPos.map(r=>
    mkProp(r.label, r.id, r.x, r.y, r.z, r.ry, Drotor, nb, cb));

  // 4 boom-mounted lift-rotors (fxDiam, always vertical)
  const fxGeoms=fxRotPos.map(r=>
    mkProp(r.label, r.id, r.x, r.y, r.z, r.ry, fxDiam, nb, cb*0.85));

  // 1 tail pusher (smaller, horizontal)
  const pusherGeom=mkProp('Tail_Pusher', pusherPos.id,
    pusherPos.x, pusherPos.y, pusherPos.z, 0, Drotor*0.55, 3, cb*0.80);

  /* ═══════════════════════════════════════════════════
     CG & NP MARKERS
     ═══════════════════════════════════════════════════ */
  function mkMarker(label,id,xPos,zOff){
    const d=0.12,len=0.12;
    return`
  <!-- ═══ ${label} MARKER ═══ -->
  <Geom type="FUSELAGE_GEOM">
${HDR(label+'_Marker',id,0,xPos-len/2,0,zOff)}
    <ParentGeom>${FUS_ID}</ParentGeom>
    <ChildIDVec/>
    <FuselageGeom>
      <ParmContainer name="FuselageGeom" id="${mkID(label+'geo')}">
        ${P('Length',     'Design',len)}
        ${P('OrderPolicy','Design',0,true)}
      </ParmContainer>
      <XSecSurf id="${mkID(label+'xs')}">
        <ParmContainer name="XSecSurf" id="${mkID(label+'xsp')}">
          ${P('TESS_W','Tesselation',8,true)}
          ${P('TESS_U','Tesselation',4,true)}
        </ParmContainer>
        <XSec type="0">
          <ParmContainer name="XSec_0" id="${mkID(label+'xs0')}">
            ${P('XLocPercent','XSec',0)} ${P('RefLength','XSec',len)}
          </ParmContainer>
          <XSecCurve type="3">
            <ParmContainer name="XSecCurve_0" id="${mkID(label+'xc0')}">
              ${P('Super_Height','SuperEllipse',d*0.4)} ${P('Super_Width','SuperEllipse',d*0.4)}
              ${P('Super_M','SuperEllipse',2)} ${P('Super_N','SuperEllipse',2)}
            </ParmContainer>
          </XSecCurve>
        </XSec>
        <XSec type="0">
          <ParmContainer name="XSec_1" id="${mkID(label+'xs1')}">
            ${P('XLocPercent','XSec',0.5)} ${P('RefLength','XSec',len)}
          </ParmContainer>
          <XSecCurve type="3">
            <ParmContainer name="XSecCurve_1" id="${mkID(label+'xc1')}">
              ${P('Super_Height','SuperEllipse',d)} ${P('Super_Width','SuperEllipse',d)}
              ${P('Super_M','SuperEllipse',2)} ${P('Super_N','SuperEllipse',2)}
            </ParmContainer>
          </XSecCurve>
        </XSec>
        <XSec type="0">
          <ParmContainer name="XSec_2" id="${mkID(label+'xs2')}">
            ${P('XLocPercent','XSec',1.0)} ${P('RefLength','XSec',len)}
          </ParmContainer>
          <XSecCurve type="3">
            <ParmContainer name="XSecCurve_2" id="${mkID(label+'xc2')}">
              ${P('Super_Height','SuperEllipse',d*0.4)} ${P('Super_Width','SuperEllipse',d*0.4)}
              ${P('Super_M','SuperEllipse',2)} ${P('Super_N','SuperEllipse',2)}
            </ParmContainer>
          </XSecCurve>
        </XSec>
      </XSecSurf>
    </FuselageGeom>
  </Geom>`;
  }
  const cgMarker=mkMarker('CG',CGM_ID,xCGtotal,fD*0.55);
  const npMarker=mkMarker('NP',NPM_ID,xNP,fD*0.65);

  /* ═══════════════════════════════════════════════════
     ASSEMBLE  .vsp3 FILE
     APIversion 3.35.0 — readable by OpenVSP 3.35–3.48.x
     Structure: GeomVec in Vehicle; geoms at top level (no Geom_Container)
     ParentGeom / ChildIDVec / SetNameVec are the correct 3.35+ tags
     ═══════════════════════════════════════════════════ */
  return`<?xml version="1.0"?>
<!-- Trail 1 eVTOL — generated by eVTOL Sizer v2.0 (Wright State University) -->
<!-- MTOW: ${f(MTOW,1)} kg  |  CG: ${f(xCGtotal,3)} m  |  NP: ${f(xNP,3)} m from nose -->
<!-- Tilt Rotor Angle: ${tiltAngle}° (0=cruise forward, 90=hover vertical) -->
<!-- Config: 2x wingtip tilt rotors + 4x boom lift rotors + 1x tail pusher = 7 propulsors -->
<Vsp_Geometry>
  <APIversion>3.48.2</APIversion>
  <Vehicle>
    <ParmContainer name="Vehicle" id="VEHICLE">
      ${P('Mass',      'Mass_Prop',MTOW)}
      ${P('CGx',       'Mass_Prop',xCGtotal)}
      ${P('CGy',       'Mass_Prop',0)}
      ${P('CGz',       'Mass_Prop',0)}
      ${P('IxxMoment', 'Mass_Prop',0)}
      ${P('IyyMoment', 'Mass_Prop',0)}
      ${P('IzzMoment', 'Mass_Prop',0)}
    </ParmContainer>
    <UserParms>
      <ParmContainer name="UserParms" id="UserParms"/>
    </UserParms>
    <SetNameVec>
      <string>All</string>
      <string>Shown</string>
      <string>NoShow</string>
    </SetNameVec>
    <GeomVec>
      <string>${FUS_ID}</string>
    </GeomVec>
  </Vehicle>
${fusGeom}
${mainWingGeom}
${vtailGeom}
${cgMarker}
${npMarker}
${wtGeoms.join('\n')}
${fxGeoms.join('\n')}
${pusherGeom}
</Vsp_Geometry>`;
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
  const[tiltAngle,setTiltAngle]=useState(90); // 90=hover, 0=cruise
  const[p,setP]=useState({
    payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
    LD:15,AR:9,eOsw:0.85,clDesign:0.60,taper:0.45,tc:0.15,
    nPropHover:6,propDiam:3.0,etaHov:0.63,etaSys:0.765,rateOfClimb:5.08,climbAngle:5,
    sedCell:275,etaBat:0.90,socMin:0.2,ewf:0.52,
    fusLen:5.6,fusDiam:1.65,
    vtGamma:45,vtCh:0.40,vtCv:0.05,vtAR:2.5,
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
          LD:15,AR:9,eOsw:0.85,clDesign:0.60,taper:0.45,tc:0.15,nPropHover:6,propDiam:3.0,
          etaHov:0.63,etaSys:0.765,rateOfClimb:5.08,climbAngle:5,sedCell:275,etaBat:0.90,socMin:0.2,ewf:0.52,
          fusLen:5.6,fusDiam:1.65,
          vtGamma:45,vtCh:0.40,vtCv:0.05,vtAR:2.5})}
          style={{marginLeft:"auto",padding:"5px 12px",background:"transparent",border:`1px solid ${C.border}`,
            borderRadius:4,color:C.muted,fontSize:9,cursor:"pointer",fontFamily:"'DM Mono',monospace"}}>↺ RESET</button>
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
            <Slider label="Lift-to-Drag L/D" unit="" value={p.LD} min={5} max={22} step={0.5} onChange={set("LD")} note={R?`Actual L/D = ${R.LDact}`:""}/>
            <Slider label="Aspect Ratio AR" unit="" value={p.AR} min={4} max={16} step={0.5} onChange={set("AR")}/>
            <Slider label="Oswald e" unit="" value={p.eOsw} min={0.5} max={1.0} step={0.01} onChange={set("eOsw")}/>
            <Slider label="Design CL" unit="" value={p.clDesign} min={0.3} max={1.2} step={0.05} onChange={set("clDesign")}/>
            <Slider label="Taper Ratio λ" unit="" value={p.taper} min={0.2} max={0.8} step={0.05} onChange={set("taper")}/>
            <Slider label="Thickness t/c" unit="" value={p.tc} min={0.08} max={0.20} step={0.01} onChange={set("tc")}/>
          </Acc>
          <Acc title="Propulsion" icon="🔧">
            <Slider label="Hover Rotors n" unit="" value={p.nPropHover} min={2} max={10} step={2} onChange={set("nPropHover")}/>
            <Slider label="Rotor Diameter" unit="m" value={p.propDiam} min={1.0} max={5.0} step={0.1} onChange={set("propDiam")} note={R?`AD = ${R.Drotor} m`:""}/>
            <Slider label="Hover η" unit="" value={p.etaHov} min={0.4} max={0.85} step={0.01} onChange={set("etaHov")}/>
            <Slider label="System η" unit="" value={p.etaSys} min={0.5} max={0.95} step={0.01} onChange={set("etaSys")}/>
            <Slider label="Rate of Climb" unit="m/s" value={p.rateOfClimb} min={1} max={12} step={0.1} onChange={set("rateOfClimb")}/>
            <Slider label="Climb Angle" unit="°" value={p.climbAngle} min={2} max={15} step={0.5} onChange={set("climbAngle")}/>
          </Acc>
          <Acc title="Battery" icon="🔋">
            <Slider label="Cell SED" unit="Wh/kg" value={p.sedCell} min={150} max={500} step={5} onChange={set("sedCell")} note="Cell-level"/>
            <Slider label="Battery η" unit="" value={p.etaBat} min={0.70} max={0.99} step={0.01} onChange={set("etaBat")}/>
            <Slider label="Min SoC" unit="" value={p.socMin} min={0.05} max={0.40} step={0.01} onChange={set("socMin")}/>
          </Acc>
          <Acc title="V-Tail Design" icon="🦋">
            <Slider label="Dihedral Angle Γ" unit="°" value={p.vtGamma} min={20} max={70} step={1} onChange={set("vtGamma")}
              note={R?`Optimal: ${R.vtGamma_opt}°`:""}/>
            <Slider label="H-Tail Vol. Coeff Ch" unit="" value={p.vtCh} min={0.25} max={0.60} step={0.01} onChange={set("vtCh")} note="Pitch authority"/>
            <Slider label="V-Tail Vol. Coeff Cv" unit="" value={p.vtCv} min={0.02} max={0.10} step={0.005} onChange={set("vtCv")} note="Yaw authority"/>
            <Slider label="Panel Aspect Ratio" unit="" value={p.vtAR} min={1.5} max={4.0} step={0.1} onChange={set("vtAR")} note="Typical 2.0–3.0"/>
          </Acc>
          <Acc title="Structure" icon="🏗️">
            <Slider label="Empty Weight Fraction" unit="" value={p.ewf} min={0.30} max={0.70} step={0.01} onChange={set("ewf")} note="Wempty/MTOW"/>
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
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
                  <KPI label="Total V-Tail Area" value={R.Svt_total} unit="m²" color={C.amber}
                    sub={`Each panel: ${R.Svt_panel} m²`}/>
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
                        ["Tail moment arm",`${R.lv} m`],["Ruddervator / panel",`${R.Srv} m²`],
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
                    <div style={{fontSize:9,color:C.muted,fontFamily:"'DM Mono',monospace",letterSpacing:"0.15em",marginBottom:4}}>GEOMETRY EXPORT — OpenVSP 3.48.2</div>
                    <div style={{fontSize:22,fontWeight:800,color:C.amber,letterSpacing:"-0.03em"}}>Trail 1 eVTOL 3D Model</div>
                    <div style={{fontSize:10,color:C.muted,marginTop:2,fontFamily:"'DM Mono',monospace"}}>
                      2× wingtip tilt rotors · 4× boom lift rotors · 1× tail pusher · wing · V-tail · fuselage · CG & NP markers
                    </div>
                  </div>
                  {/* Tilt angle control */}
                  <div style={{display:"flex",flexDirection:"column",gap:6,padding:"10px 14px",
                    background:"#0a0d14",border:`1px solid ${C.teal}33`,borderRadius:8,minWidth:200}}>
                    <div style={{fontSize:8,color:C.teal,fontFamily:"'DM Mono',monospace",letterSpacing:"0.12em",textTransform:"uppercase"}}>
                      Tilt Rotor Angle
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{fontSize:11,color:C.muted,fontFamily:"'DM Mono',monospace",minWidth:60}}>
                        {tiltAngle===0?"CRUISE":tiltAngle===90?"HOVER":"TRANSITION"}
                      </div>
                      <input type="range" min={0} max={90} step={5} value={tiltAngle}
                        onChange={e=>setTiltAngle(Number(e.target.value))}
                        style={{flex:1,cursor:"pointer"}}/>
                      <div style={{fontSize:16,fontWeight:800,color:C.amber,fontFamily:"'DM Mono',monospace",minWidth:40,textAlign:"right"}}>
                        {tiltAngle}°
                      </div>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:C.dim,fontFamily:"'DM Mono',monospace"}}>
                      <span>0° = forward cruise</span><span>90° = vertical hover</span>
                    </div>
                  </div>
                  <div style={{marginLeft:"auto",display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                    <button
                      onClick={()=>{
                        const xml=generateVSPFile(p,R,tiltAngle);
                        const blob=new Blob([xml],{type:"application/xml"});
                        const url=URL.createObjectURL(blob);
                        const a=document.createElement("a");
                        a.href=url; a.download=`Trail1_eVTOL_tilt${tiltAngle}deg.vsp3`; a.click();
                        URL.revokeObjectURL(url);
                      }}
                      style={{padding:"10px 22px",background:`linear-gradient(135deg,${C.amber},#f97316)`,
                        border:"none",borderRadius:6,color:"#07090f",fontSize:13,fontWeight:800,
                        cursor:"pointer",letterSpacing:"0.05em",fontFamily:"'DM Mono',monospace",
                        boxShadow:`0 0 20px ${C.amber}55`}}>
                      ⬇  Download .vsp3 ({tiltAngle}°)
                    </button>
                  </div>
                </div>

                {/* Geometry summary cards */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                  {[
                    ["Fuselage","FUSELAGE_GEOM","L "+p.fusLen+" m  Ø "+p.fusDiam+" m","#64748b"],
                    ["Main Wing","WING_GEOM","S="+R.Swing+" m²  b="+R.bWing+" m","#3b82f6"],
                    ["V-Tail","WING_GEOM","Γ="+p.vtGamma+"°  S="+R.Svt_total.toFixed(2)+" m²","#8b5cf6"],
                    ["7 Propulsors","Trail 1 Config","2 tilt-tip + 4 boom + 1 pusher","#22c55e"],
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
                          const xWingLE_  = (R.xACwing - 0.25*R.Cr_).toFixed(3);
                          const zWing_    = (-p.fusDiam*0.10).toFixed(3);
                          const xVtLE_    = ((R.xACwing+R.lv) - 0.25*R.MAC_vt).toFixed(3);
                          const zVt_      = (p.fusDiam*0.05).toFixed(3);
                          const yBoom_    = (R.bWing*0.28).toFixed(3);
                          const zBoom_    = (p.fusDiam*0.30).toFixed(3);
                          const xBoomFore_= (parseFloat(xWingLE_) - R.Drotor*0.60).toFixed(3);
                          const xBoomAft_ = (parseFloat(xWingLE_) + R.Cr_ + R.Drotor*0.35).toFixed(3);
                          const xtilt_    = (parseFloat(xWingLE_) + R.Cr_*0.50).toFixed(3);
                          const ztilt_    = (parseFloat(zWing_) + R.Drotor*0.55).toFixed(3);
                          const xPush_    = (p.fusLen - R.Drotor*0.25).toFixed(3);
                          const rows=[
                            ["Fuselage","0.000","0","0","FUSELAGE_GEOM"],
                            ["Main Wing",xWingLE_,"0 (root)",zWing_,"WING_GEOM · 2° dihedral"],
                            ["V-Tail",xVtLE_,"0 (root)",zVt_,`WING_GEOM · Γ=${p.vtGamma}°`],
                            ["Tilt Rotor PORT",xtilt_,`+${(R.bWing/2).toFixed(3)}`,ztilt_,`PROP_GEOM · ry=${-tiltAngle}°`],
                            ["Tilt Rotor STBD",xtilt_,`-${(R.bWing/2).toFixed(3)}`,ztilt_,`PROP_GEOM · ry=${-tiltAngle}°`],
                            ["Boom Rotor P-FWD",xBoomFore_,`+${yBoom_}`,zBoom_,"PROP_GEOM · ry=-90°"],
                            ["Boom Rotor P-AFT",xBoomAft_, `+${yBoom_}`,zBoom_,"PROP_GEOM · ry=-90°"],
                            ["Boom Rotor S-FWD",xBoomFore_,`-${yBoom_}`,zBoom_,"PROP_GEOM · ry=-90°"],
                            ["Boom Rotor S-AFT",xBoomAft_, `-${yBoom_}`,zBoom_,"PROP_GEOM · ry=-90°"],
                            ["Tail Pusher",xPush_,"0",(p.fusDiam*0.05).toFixed(3),"PROP_GEOM · ry=0°"],
                            ["CG Marker",R.xCGtotal.toFixed(3),"0",(p.fusDiam*0.55).toFixed(3),"FUSELAGE_GEOM"],
                            ["NP Marker",R.xNP.toFixed(3),"0",(p.fusDiam*0.65).toFixed(3),"FUSELAGE_GEOM"],
                          ];
                          return rows.map((r,i)=>(
                            <tr key={i} style={{background:i%2===0?C.bg:"transparent",
                              borderBottom:`1px solid ${C.border}22`}}>
                              {r.map((cell,j)=>(
                                <td key={j} style={{padding:"4px 6px",
                                  color:j===0?C.amber:j===4?C.muted:C.text,
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
                        {indent:0,icon:"🏗️",label:"Fuselage (FUSELAGE_GEOM)",detail:`L=${p.fusLen}m  Ø=${p.fusDiam}m  9 cross-sections`,col:"#94a3b8"},
                        {indent:1,icon:"✈️",label:"Main Wing (WING_GEOM)",detail:`b=${R.bWing}m  S=${R.Swing}m²  AR=${p.AR}  λ=${p.taper}`,col:C.blue},
                        {indent:1,icon:"🦋",label:"V-Tail (WING_GEOM · XZ sym)",detail:`Γ=${p.vtGamma}°  S_panel=${R.Svt_panel}m²  AR=${p.vtAR}`,col:"#8b5cf6"},
                        {indent:1,icon:"🟢",label:"CG Marker",detail:`x=${R.xCGtotal}m  SM=${((R.SM)*100).toFixed(1)}% MAC`,col:C.green},
                        {indent:1,icon:"🔵",label:"NP Marker",detail:`x=${R.xNP}m from nose`,col:C.teal},
                        {indent:1,icon:"🔄",label:`TiltRotor PORT (PROP_GEOM) — ${tiltAngle}°`,detail:`D=${R.Drotor}m  3 blades  y=+${(R.bWing/2).toFixed(2)}m (wingtip)  ry=${-tiltAngle}°`,col:C.amber},
                        {indent:1,icon:"🔄",label:`TiltRotor STBD (PROP_GEOM) — ${tiltAngle}°`,detail:`D=${R.Drotor}m  3 blades  y=-${(R.bWing/2).toFixed(2)}m (wingtip)  ry=${-tiltAngle}°`,col:C.amber},
                        {indent:1,icon:"⬆️",label:"BoomRotor PORT FWD (PROP_GEOM)",detail:`D=${(R.Drotor*0.72).toFixed(2)}m  y=+${(R.bWing*0.28).toFixed(2)}m (mid-wing from calc)  ry=-90°`,col:"#f97316"},
                        {indent:1,icon:"⬆️",label:"BoomRotor PORT AFT (PROP_GEOM)",detail:`D=${(R.Drotor*0.72).toFixed(2)}m  y=+${(R.bWing*0.28).toFixed(2)}m  aft of wing TE  ry=-90°`,col:"#f97316"},
                        {indent:1,icon:"⬆️",label:"BoomRotor STBD FWD (PROP_GEOM)",detail:`D=${(R.Drotor*0.72).toFixed(2)}m  y=-${(R.bWing*0.28).toFixed(2)}m (mid-wing from calc)  ry=-90°`,col:"#f97316"},
                        {indent:1,icon:"⬆️",label:"BoomRotor STBD AFT (PROP_GEOM)",detail:`D=${(R.Drotor*0.72).toFixed(2)}m  y=-${(R.bWing*0.28).toFixed(2)}m  aft of wing TE  ry=-90°`,col:"#f97316"},
                        {indent:1,icon:"🚀",label:"Tail Pusher (PROP_GEOM)",detail:`D=${(R.Drotor*0.55).toFixed(2)}m  3 blades  @x=${(p.fusLen-R.Drotor*0.25).toFixed(2)}m  ry=0° (horizontal)`,col:"#ec4899"},
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
                  <Panel title="Design Parameter Summary (used in .vsp3)">
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

                  <Panel title="How to Use the .vsp3 File">
                    {[
                      ["1","Download","Click the Download .vsp3 button above to save the file."],
                      ["2","Open","Launch OpenVSP 3.x → File → Open → select Trail1_eVTOL.vsp3."],
                      ["3","Inspect","All components are attached to the fuselage. Use the Component Tree to navigate."],
                      ["4","CG / NP","Small sphere markers show CG (green) and NP (blue) positions along the X-axis."],
                      ["5","Rotors","PROP_GEOM disks are Y_Rot=−90° so thrust points +Z (upward). Adjust blade pitch as needed."],
                      ["6","V-Tail","WING_GEOM with XZ symmetry and dihedral=Γ creates both panels. Ruddervator area = 30% of panel."],
                      ["7","Iterate","Change parameters in the sidebar → click Download again to update the geometry."],
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
                <div style={{display:"flex",justifyContent:"center",gap:12,paddingTop:4,paddingBottom:8,flexWrap:"wrap"}}>
                  <button
                    onClick={()=>{
                      const xml=generateVSPFile(p,R,0);
                      const blob=new Blob([xml],{type:"application/xml"});
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url; a.download="Trail1_eVTOL_CRUISE_0deg.vsp3"; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{padding:"10px 24px",background:"transparent",
                      border:`2px solid ${C.teal}`,borderRadius:6,color:C.teal,fontSize:12,fontWeight:700,
                      cursor:"pointer",letterSpacing:"0.06em",fontFamily:"'DM Mono',monospace"}}>
                    ✈️  Cruise Config (0°)
                  </button>
                  <button
                    onClick={()=>{
                      const xml=generateVSPFile(p,R,tiltAngle);
                      const blob=new Blob([xml],{type:"application/xml"});
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url; a.download=`Trail1_eVTOL_tilt${tiltAngle}deg.vsp3`; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{padding:"10px 32px",background:`linear-gradient(135deg,${C.amber},#f97316)`,
                      border:"none",borderRadius:6,color:"#07090f",fontSize:14,fontWeight:800,
                      cursor:"pointer",letterSpacing:"0.06em",fontFamily:"'DM Mono',monospace",
                      boxShadow:`0 0 30px ${C.amber}44`}}>
                    ⬇  Download Trail1 — {tiltAngle}° Tilt
                  </button>
                  <button
                    onClick={()=>{
                      const xml=generateVSPFile(p,R,90);
                      const blob=new Blob([xml],{type:"application/xml"});
                      const url=URL.createObjectURL(blob);
                      const a=document.createElement("a");
                      a.href=url; a.download="Trail1_eVTOL_HOVER_90deg.vsp3"; a.click();
                      URL.revokeObjectURL(url);
                    }}
                    style={{padding:"10px 24px",background:"transparent",
                      border:`2px solid #22c55e`,borderRadius:6,color:"#22c55e",fontSize:12,fontWeight:700,
                      cursor:"pointer",letterSpacing:"0.06em",fontFamily:"'DM Mono',monospace"}}>
                    🚁  Hover Config (90°)
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
