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
  };
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

const TABS=["Overview","Mission","Wing & Aero","Propulsion","Battery","Performance","Stability","Convergence"];
const TABI=["⬛","🛫","✈️","🔧","🔋","📈","⚖️","🔄"];
const TTP={contentStyle:{background:"#131c2e",border:"1px solid #2a3a5c",borderRadius:6,fontSize:12,color:"#e2e8f0",boxShadow:"0 4px 20px rgba(0,0,0,0.8)"},labelStyle:{color:"#94a3b8",fontSize:12,fontWeight:600},itemStyle:{color:"#e2e8f0",fontSize:12}};

/* ═══════════════════════════════════
   APP
   ═══════════════════════════════════ */
export default function App(){
  const[tab,setTab]=useState(0);
  const[p,setP]=useState({
    payload:455,range:250,vCruise:67,cruiseAlt:1000,reserveRange:60,hoverHeight:15.24,
    LD:15,AR:9,eOsw:0.85,clDesign:0.60,taper:0.45,tc:0.15,
    nPropHover:6,propDiam:3.0,etaHov:0.63,etaSys:0.765,rateOfClimb:5.08,climbAngle:5,
    sedCell:275,etaBat:0.90,socMin:0.2,ewf:0.52,
    fusLen:5.6,fusDiam:1.65,
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
          fusLen:5.6,fusDiam:1.65})}
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

            {/* ──── TAB 7: CONVERGENCE ──── */}
            {tab===7&&(
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

            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
