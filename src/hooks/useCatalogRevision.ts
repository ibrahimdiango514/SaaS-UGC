import {useEffect,useState} from 'react';
const EVENT='vyora-catalog-changed';
/** Local writes update every mounted view immediately. Focus and bounded polling
 * pick up external admin/cron/database changes without exposing private tables
 * via Realtime or requiring a full application reload. */
export function invalidateCatalog(){if(typeof window!=='undefined')window.dispatchEvent(new Event(EVENT));}
export function useCatalogRevision(){
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  const update=()=>{if(document.visibilityState!=='hidden')setRevision(n=>n+1);};
  const timer=window.setInterval(update,20000);
  window.addEventListener(EVENT,update);window.addEventListener('focus',update);document.addEventListener('visibilitychange',update);
  return()=>{window.clearInterval(timer);window.removeEventListener(EVENT,update);window.removeEventListener('focus',update);document.removeEventListener('visibilitychange',update);};
 },[]);
 return revision;
}
