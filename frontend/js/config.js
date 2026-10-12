/* Konfigurasi Supabase. Masukkan URL + publishable/anon key proyek Anda melalui UI Settings.
   Tidak pernah menaruh service_role key pada frontend. */
(function(){
  const URL_KEY="retailpro_supabase_url", ANON_KEY="retailpro_supabase_anon_key";
  let client=null;
  function credentials(){return {url:(localStorage.getItem(URL_KEY)||"").trim().replace(/\/+$/,""),key:(localStorage.getItem(ANON_KEY)||"").trim()};}
  function connect(){
    const {url,key}=credentials();
    if(!url||!key){client=null;return {connected:false,mode:"demo"};}
    if(!window.supabase?.createClient)throw new Error("Supabase JS CDN tidak termuat. Periksa internet lalu muat ulang.");
    client=window.supabase.createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
    return {connected:true,mode:"supabase"};
  }
  function configure(url,key){
    const u=String(url||"").trim().replace(/\/+$/,""), k=String(key||"").trim();
    if(!u||!k)throw new Error("Project URL dan publishable/anon key wajib diisi.");
    let parsed;try{parsed=new URL(u)}catch(_){throw new Error("Project URL tidak valid.");}
    if(parsed.protocol!=="https:"||!parsed.hostname.endsWith(".supabase.co"))throw new Error("Gunakan URL HTTPS proyek Supabase yang berakhiran .supabase.co.");
    localStorage.setItem(URL_KEY,u);localStorage.setItem(ANON_KEY,k);return connect();
  }
  function getClient(){if(!client)throw new Error("Supabase belum terhubung.");return client;}
  const isConnected=()=>!!client;
  try{connect()}catch(e){console.warn(e.message)}
  window.RetailConfig={connect,configure,credentials,getClient,isConnected,clear(){localStorage.removeItem(URL_KEY);localStorage.removeItem(ANON_KEY);client=null;}};
})();