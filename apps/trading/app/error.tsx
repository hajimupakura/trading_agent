"use client";
export default function GlobalError({ error, reset }:{error:Error;reset:()=>void}) { return <main className="login"><section className="panel"><h1>Command center unavailable</h1><p className="muted">{error.message}</p><button className="button" onClick={reset}>Retry</button></section></main>; }
