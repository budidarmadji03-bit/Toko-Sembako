(() => {
"use strict";
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const money=n=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(n)||0);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function productKind(product){
 const name=String(product.nama||"").toLowerCase(),category=String(product.kategori||"").toLowerCase();
 if(/susu|milk|dairy/.test(name))return "milk";
 if(/air mineral|air minum|mineral water|bottled water/.test(name))return "water";
 if(/\bmi\b|\bmie\b|noodle|instan/.test(name))return "noodles";
 if(/beras|rice/.test(name))return "rice";
 if(/minyak goreng|cooking oil/.test(name))return "oil";
 if(/tepung|flour/.test(name))return "flour";
 if(/gula|sugar/.test(name))return "sugar";
 if(/minuman|beverage|drink/.test(name))return "drink";
 if(/beras|serealia|rice/.test(category))return "rice";
 if(/\bmi\b|\bmie\b|noodle|instan/.test(category))return "noodles";
 if(/air mineral|air minum|minuman|beverage|drink/.test(category))return "drink";
 if(/minyak|cooking oil/.test(category))return "oil";
 if(/tepung|flour/.test(category)&&!/gula|sugar/.test(category))return "flour";
 if(/gula|sugar/.test(category)&&!/tepung|flour/.test(category))return "sugar";
 return "other";
}
function productImage(product){
 if(product.foto_url)return `<img class="product-image product-image--uploaded" src="${esc(product.foto_url)}" alt="${esc(product.nama)}" loading="lazy">`;
 if(/^data:image\/(?:webp|png|jpeg);base64,[a-z0-9+/=]+$/i.test(product.foto_data||""))return `<img class="product-image product-image--uploaded" src="${esc(product.foto_data)}" alt="${esc(product.nama)}" loading="lazy">`;
 const kind=productKind(product);
 const images={
  water:"lemineral.jpg",
  noodles:"mie-sedap.jpg",
  milk:"susu-uht.png",
  rice:"rice.jpg",
  oil:"cooking-oil.jpg",
  sugar:"sugar.jpg",
  flour:"flour.jpg"
 };
 const file=images[kind];
 if(!file)return `<span class="photo-unavailable" role="img" aria-label="Foto belum tersedia untuk ${esc(product.nama)}">Foto produk belum tersedia</span>`;
 return `<img class="product-image product-image--${kind}" src="../assets/products/${file}" alt="${esc(product.nama)}" loading="lazy" onerror="this.hidden=true;this.parentElement.classList.add('photo-unavailable')">`;
}
function renderWelcomeProducts(){
 const display=$("#welcomeProductDisplay");
 if(!display)return;
 const featuredDefaults={water:{nama:"Air Mineral",kategori:"Minuman"},noodles:{nama:"Mi Instan",kategori:"Mi & Makanan Instan"},milk:{nama:"Susu UHT",kategori:"Minuman"}};
 const showcase=["water","noodles","milk"].map(kind=>products.find(p=>productKind(p)===kind)||featuredDefaults[kind]);
 display.innerHTML=showcase.map(p=>`<div class="welcome-product">${productImage(p)}</div>`).join("");
}
let products=[],customers=[],sales=[],saleItems=[],purchases=[],expenses=[],stockMovements=[],cart=[],toastTimer;
let accountingData={error:"Migrasi backend/sql/09_accounting_ledger.sql belum diterapkan."};
function db(){return window.RetailConfig.getClient();}
async function checked(result){
 const {data,error}=await result;
 if(error)throw new Error(error.message||"Permintaan ke Supabase gagal.");
 return data;
}
async function fetchAll(query){
 const rows=[];
 for(let start=0;;start+=1000){
  const batch=await checked(query.range(start,start+999));
  rows.push(...batch);
  if(batch.length<1000)return rows;
 }
}
function toast(msg,error=false){const e=$("#toast");e.textContent=msg;e.className="toast show"+(error?" error":"");clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.className="toast",3500)}
function empty(title,desc){return `<div class="empty"><i class="fa-solid fa-box-open"></i><b>${title}</b><p>${desc}</p></div>`}
function statusConnection(connected=true){const status=$("#connectionStatus");status.textContent=connected?"Terhubung ke Supabase":"Supabase tidak terhubung";status.style.color=connected?"#16a34a":"#dc2626";const label=$("#connectionLabel");if(label)label.innerHTML=`<i class="fa-solid ${connected?"fa-cloud":"fa-triangle-exclamation"}"></i><b>${connected?"Supabase":"Koneksi gagal"}</b>`;}
function withTimeout(promise,milliseconds,message){
 let timeout;
 return Promise.race([
  promise,
  new Promise((_,reject)=>{timeout=setTimeout(()=>{const error=new Error(message);error.code="AUTH_CONNECTION_TIMEOUT";reject(error)},milliseconds)})
 ]).finally(()=>clearTimeout(timeout));
}
async function loadData(){
 window.RetailFinancialReports?.setLoading();
 let client;
 try{client=db()}catch(error){window.RetailFinancialReports?.setError(error.message);throw error}
 const operationalData=Promise.all([
  fetchAll(client.from("barang").select("*").order("nama")),
  fetchAll(client.from("pelanggan").select("*").order("nama")),
  fetchAll(client.from("penjualan").select("*").order("tanggal",{ascending:false})),
  fetchAll(client.from("detail_penjualan").select("*").order("created_at")),
  fetchAll(client.from("pembelian_stok").select("*").order("tanggal",{ascending:false})),
  fetchAll(client.from("beban_operasional").select("*").order("tanggal",{ascending:false})),
  fetchAll(client.from("mutasi_persediaan").select("*").order("tanggal",{ascending:false}))
 ]);
 const accountingRequest=Promise.all([
  checked(client.from("accounting_settings").select("*").eq("id",true).single()),
  fetchAll(client.from("chart_of_accounts").select("*").order("code")),
  fetchAll(client.from("journal_entries").select("*").order("entry_date").order("id")),
  fetchAll(client.from("journal_lines").select("*").order("id")),
  fetchAll(client.from("accounting_payments").select("*").order("payment_date").order("id")),
  fetchAll(client.from("account_reconciliations").select("*").order("statement_date",{ascending:false}).order("id"))
 ]).then(async ([settings,accounts,entries,lines,payments,reconciliations])=>{
  let openingDraft=null,openingDraftError="";
  try{openingDraft=await checked(client.from("accounting_opening_drafts").select("*").eq("id",true).maybeSingle())}
  catch(error){openingDraftError=`Fitur draft saldo awal belum tersedia; jalankan migrasi backend/sql/11_opening_balance_drafts.sql. ${error.message||""}`}
  return {settings,accounts,entries,lines,payments,reconciliations,openingDraft,openingDraftError,error:""};
 }).catch(error=>({
  settings:null,accounts:[],entries:[],lines:[],payments:[],reconciliations:[],openingDraft:null,openingDraftError:"",
  error:`Akuntansi belum tersedia: ${error.message||"migrasi atau akses Owner belum siap."}`
 }));
 const [rows,accounting]=await Promise.all([operationalData,accountingRequest])
  .catch(error=>{window.RetailFinancialReports?.setError(error.message);throw error});
 const [productRows,customerRows,saleRows,detailRows,purchaseRows,expenseRows,stockRows]=rows;
 accountingData=accounting;
 products=productRows;
 customers=customerRows;
 saleItems=detailRows;
 sales=saleRows.map(row=>{
  const items=detailRows.filter(detail=>detail.penjualan_id===row.id);
  return {...row,channel:row.recipient_name?"delivery":"counter",items:items.map(item=>({...item,id:item.barang_id,qty:item.jumlah,price:item.harga_satuan,cost:item.harga_pokok_satuan,name:item.nama_barang,unit:productRows.find(product=>product.id===item.barang_id)?.satuan||""}))};
 });
 purchases=purchaseRows;
 expenses=expenseRows;
 stockMovements=stockRows;
 statusConnection(true);
 window.RetailFinancialReports?.clearError();
 renderAll();
}
function renderAll(){renderDashboard();renderProducts();renderSaleProducts();renderCustomers();renderSalesReport();renderDeliveryOrders();populateCustomers();populateStockInProducts();renderCart();renderWelcomeProducts();}
function populateStockInProducts(){const s=$("#stockInProduct");if(!s)return;const old=s.value;s.innerHTML=products.filter(p=>p.aktif!==false).map(p=>`<option value="${esc(p.id)}">${esc(p.sku)} — ${esc(p.nama)} (stok ${p.stok})</option>`).join("")||'<option value="">Belum ada barang</option>';if(products.some(p=>String(p.id)===old))s.value=old;const p=products.find(p=>String(p.id)===s.value);if(p)$("#stockInCost").value=p.harga_beli;}
function page(name){$$(".page").forEach(p=>p.classList.toggle("hidden",p.id!=="page-"+name));$$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===name));$("#breadcrumb").textContent=({dashboard:"Dashboard",inventory:"Persediaan Barang",sales:"Penjualan / Kasir",delivery:"Pesanan Antar",customers:"Pelanggan",reports:"Laporan Keuangan"})[name]||"Dashboard";$("#sidebar").classList.remove("open");$("#scrim").classList.remove("show");if(name==="sales")renderSaleProducts();if(name==="delivery")renderDeliveryOrders();}
function productValue(p){return Number(p.stok||0)*Number(p.harga_beli||0)}
function todayISO(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`}
function requestKey(){if(globalThis.crypto?.randomUUID)return globalThis.crypto.randomUUID();if(!globalThis.crypto?.getRandomValues)throw new Error("Browser tidak menyediakan generator acak aman untuk mencegah pembayaran ganda.");const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}
function dateKey(value){if(!value)return"";const text=String(value);if(/^\d{4}-\d{2}-\d{2}$/.test(text))return text;const date=new Date(text);if(Number.isNaN(date.getTime()))return text.slice(0,10);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`}
function activeProducts(){return products.filter(p=>p.aktif!==false)}
function salesToday(){return sales.filter(s=>dateKey(s.tanggal||s.created_at)===todayISO()&&s.status==="selesai")}
function renderDashboard(){
 const active=activeProducts(),todays=salesToday();$("#todaySales").textContent=money(todays.reduce((a,s)=>a+Number(s.total||0),0));$("#todayTransactions").textContent=`${todays.length} transaksi hari ini`;
 $("#productCount").textContent=active.length;$("#lowStockCount").textContent=active.filter(p=>Number(p.stok)<=Number(p.stok_minimum)).length;$("#inventoryValue").textContent=money(active.reduce((a,p)=>a+productValue(p),0));
 const low=active.filter(p=>Number(p.stok)<=Number(p.stok_minimum)).sort((a,b)=>Number(a.stok)-Number(b.stok)).slice(0,6);
 $("#lowStockList").innerHTML=low.length?low.map(p=>`<div class="low-row"><span class="product-thumb">${productImage(p,100)}</span><div class="low-info"><b>${esc(p.nama)}</b><small>${esc(p.sku)} · minimum ${p.stok_minimum} ${esc(p.satuan)}</small></div><span class="stock-badge low">${p.stok} ${esc(p.satuan)}</span></div>`).join(""):empty("Stok aman","Tidak ada barang yang berada di bawah batas minimum.");
 const days=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const iso=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;days.push({iso,label:d.toLocaleDateString("id-ID",{weekday:"short"}),value:sales.filter(s=>dateKey(s.tanggal||s.created_at)===iso&&s.status==="selesai").reduce((a,s)=>a+Number(s.total||0),0)})}
 const max=Math.max(1,...days.map(d=>d.value));$("#salesChart").innerHTML=`<div class="chart-bars">${days.map(d=>`<div class="chart-col" title="${d.label}: ${money(d.value)}"><div class="chart-bar" style="height:${Math.max(d.value?5:2,d.value/max*100)}%"></div><small>${d.label}</small></div>`).join("")}</div>`;
 const start=new Date();start.setDate(start.getDate()-6);start.setHours(0,0,0,0);
 const startKey=dateKey(start),endKey=todayISO();
 const recent=sales.filter(s=>{const key=dateKey(s.tanggal||s.created_at);return key>=startKey&&key<=endKey}).sort((a,b)=>String(b.tanggal||b.created_at).localeCompare(String(a.tanggal||a.created_at)));
 $("#recentSales").innerHTML=recent.length?`<table class="data-table"><thead><tr><th>TANGGAL</th><th>NOMOR TRANSAKSI</th><th>PELANGGAN</th><th>TOTAL</th><th>METODE PEMBAYARAN</th><th>STATUS</th><th>NOTA</th></tr></thead><tbody>${recent.map(s=>{const customer=customers.find(row=>String(row.id)===String(s.pelanggan_id));const payment=({cash:"Tunai",transfer:"Transfer",qris:"QRIS",debit:"Debit"})[s.metode_pembayaran]||s.metode_pembayaran||"—";return `<tr><td>${new Date(s.tanggal||s.created_at).toLocaleString("id-ID")}</td><td class="bold">${esc(s.nomor_nota||"—")}</td><td>${esc(customer?.nama||s.recipient_name||"Pelanggan umum")}</td><td class="bold">${money(s.total)}</td><td>${esc(payment)}</td><td><span class="status-pill ${saleStatusClass(s.status)}">${esc(saleStatusLabel(s))}</span></td><td><button class="table-action" data-print-sale="${esc(s.id)}" title="Cetak nota"><i class="fa-solid fa-print"></i></button></td></tr>`}).join("")}</tbody></table>`:empty("Belum ada transaksi 7 hari terakhir","Transaksi dari Supabase akan tampil di sini.");
}
function productsTable(rows){if(!rows.length)return empty("Barang tidak ditemukan","Tambahkan barang atau ubah kata pencarian.");return `<table class="data-table"><thead><tr><th>BARANG</th><th>KATEGORI</th><th>HARGA BELI</th><th>HARGA JUAL</th><th>STOK</th><th>NILAI STOK</th><th>AKSI</th></tr></thead><tbody>${rows.map(p=>`<tr><td><div class="table-product"><span class="product-thumb">${productImage(p,120)}</span><div><b>${esc(p.nama)}</b><small>${esc(p.sku)} · ${esc(p.satuan)}</small></div></div></td><td>${esc(p.kategori)}</td><td>${money(p.harga_beli)}</td><td class="bold">${money(p.harga_jual)}</td><td><span class="stock-badge ${Number(p.stok)<=Number(p.stok_minimum)?"low":"ok"}">${p.stok} ${esc(p.satuan)}</span><small class="subline">Min. ${p.stok_minimum}</small></td><td>${money(productValue(p))}</td><td><div class="actions"><button class="table-action" data-edit-product="${esc(p.id)}" title="Edit"><i class="fa-solid fa-pen"></i></button><button class="table-action danger" data-delete-product="${esc(p.id)}" title="Hapus/nonaktifkan"><i class="fa-solid fa-trash"></i></button></div></td></tr>`).join("")}</tbody></table>`}
function renderProducts(){const q=($("#productSearch")?.value||"").toLowerCase().trim(),f=$("#stockFilter")?.value||"",active=activeProducts(),rows=active.filter(p=>[p.nama,p.sku,p.kategori].some(v=>String(v).toLowerCase().includes(q))).filter(p=>f==="low"?Number(p.stok)<=Number(p.stok_minimum):f==="available"?Number(p.stok)>0:true);$("#productsTable").innerHTML=!active.length?empty("Belum ada barang di Supabase","Gunakan tombol Tambah barang untuk membuat produk di database toko."):productsTable(rows)}
function renderSaleProducts(){const q=($("#saleSearch")?.value||"").toLowerCase().trim();const rows=products.filter(p=>p.aktif!==false&&Number(p.stok)>0&&[p.nama,p.sku,p.kategori].some(v=>String(v).toLowerCase().includes(q)));$("#saleProductGrid").innerHTML=rows.length?rows.map(p=>`<button class="product-card" data-add-cart="${esc(p.id)}"><span class="product-photo">${productImage(p,480)}<span class="photo-stock">${p.stok} ${esc(p.satuan)}</span></span><span class="product-card-info"><small class="product-category">${esc(p.kategori)}</small><b>${esc(p.nama)}</b><strong>${money(p.harga_jual)}</strong><span class="add-hint"><i class="fa-solid fa-plus"></i> Tambah ke keranjang</span></span></button>`).join(""):empty("Barang tidak tersedia","Tidak ada barang cocok dengan pencarian atau stok kosong.")}
function renderCart(){
 if(!cart.length){$("#saleDiscount").value=0;$("#amountPaid").value=0}
 const subtotal=cart.reduce((a,x)=>a+x.qty*x.price,0),discount=Math.max(0,Number($("#saleDiscount")?.value||0)),total=Math.max(0,subtotal-Math.min(discount,subtotal)),paid=Math.max(0,Number($("#amountPaid")?.value||0));
 $("#cartCount").textContent=`${cart.reduce((a,x)=>a+x.qty,0)} unit · ${cart.length} jenis`;$("#cartSubtotal").textContent=money(subtotal);$("#cartTotal").textContent=money(total);$("#changeAmount").textContent=money(Math.max(0,paid-total));
 $("#cartItems").innerHTML=cart.length?cart.map(x=>`<div class="cart-item"><div class="cart-item-main"><b>${esc(x.name)}</b><small>${money(x.price)} / ${esc(x.unit)}</small></div><div class="qty-control"><button data-cart-minus="${esc(x.id)}">−</button><span>${x.qty}</span><button data-cart-plus="${esc(x.id)}">+</button></div><b class="cart-line">${money(x.qty*x.price)}</b><button class="remove-item" data-cart-remove="${esc(x.id)}"><i class="fa-solid fa-xmark"></i></button></div>`).join(""):empty("Keranjang kosong","Pilih barang dari daftar di sebelah kiri.");
 $("#checkoutButton").disabled=!cart.length||total<=0;
}
function populateCustomers(){const s=$("#saleCustomer"),old=s.value;s.innerHTML='<option value="">Pelanggan umum</option>'+customers.map(c=>`<option value="${esc(c.id)}">${esc(c.nama)}</option>`).join("");if(customers.some(c=>String(c.id)===old))s.value=old;}
function customersTable(rows){if(!rows.length)return empty("Belum ada pelanggan","Tambah pelanggan jika dibutuhkan.");return `<table class="data-table"><thead><tr><th>NAMA</th><th>TELEPON</th><th>ALAMAT</th><th>AKSI</th></tr></thead><tbody>${rows.map(c=>`<tr><td class="bold">${esc(c.nama)}</td><td>${esc(c.telepon||"—")}</td><td>${esc(c.alamat||"—")}</td><td><div class="actions"><button class="table-action" data-edit-customer="${esc(c.id)}"><i class="fa-solid fa-pen"></i></button><button class="table-action danger" data-delete-customer="${esc(c.id)}"><i class="fa-solid fa-trash"></i></button></div></td></tr>`).join("")}</tbody></table>`}
function renderCustomers(){const q=($("#customerSearch")?.value||"").toLowerCase();$("#customersTable").innerHTML=customersTable(customers.filter(c=>[c.nama,c.telepon,c.alamat].some(v=>String(v||"").toLowerCase().includes(q))));populateCustomers()}
function saleStatusLabel(sale){const status=sale.status;if(status==="selesai")return sale.recipient_name?"Sudah sampai":"Selesai";return({menunggu:"Menunggu konfirmasi",diproses:"Sedang diproses",dalam_pengiriman:"Dalam pengiriman",gagal_dikirim:"Gagal dikirim",dibatalkan:"Dibatalkan"})[status]||status||"Selesai"}
function saleStatusClass(status){return["dibatalkan","gagal_dikirim"].includes(status)?"cancelled":status==="selesai"?"done":"pending"}
function printSaleReceipt(id){
 const sale=sales.find(row=>String(row.id)===String(id));
 if(!sale)throw new Error("Transaksi tidak ditemukan pada data yang sedang dimuat.");
 const customer=customers.find(row=>String(row.id)===String(sale.pelanggan_id));
 const items=saleItems.filter(item=>String(item.penjualan_id)===String(sale.id)).map(item=>({
  name:item.nama_barang,sku:item.sku,quantity:item.jumlah,unit:products.find(product=>String(product.id)===String(item.barang_id))?.satuan||"",
  price:item.harga_satuan,subtotal:item.subtotal
 }));
 if(!items.length)throw new Error("Detail barang transaksi tidak ditemukan; nota tidak dapat dicetak.");
 window.RetailReceipt.print({
  invoice:sale.nomor_nota||sale.id,date:new Date(sale.tanggal||sale.created_at).toLocaleString("id-ID"),
  customer:sale.recipient_name||customer?.nama||"Pelanggan umum",
  paymentMethod:({cash:"Tunai",transfer:"Transfer",qris:"QRIS",debit:"Kartu debit"})[sale.metode_pembayaran]||sale.metode_pembayaran||"—",
  status:saleStatusLabel(sale),deliveryAddress:sale.delivery_address||"",deliveryDate:sale.tanggal_pengiriman?new Date(sale.tanggal_pengiriman).toLocaleString("id-ID"):"",
  items,subtotal:sale.subtotal,discount:sale.diskon,total:sale.total,paid:sale.jumlah_dibayar,change:sale.kembalian
 });
}
function handlePrintReceiptClick(event){
 const button=event.target.closest("[data-print-sale]");
 if(!button)return;
 try{printSaleReceipt(button.dataset.printSale)}
 catch(error){toast(error.message||"Nota gagal dicetak.",true)}
}
function salesTable(rows,actions=true){if(!rows.length)return empty("Belum ada transaksi","Transaksi akan muncul setelah penjualan disimpan.");return `<table class="data-table"><thead><tr><th>NOMOR NOTA</th><th>TANGGAL</th><th>PELANGGAN</th><th>METODE</th><th>DISKON</th><th>TOTAL</th><th>STATUS</th>${actions?"<th>AKSI</th>":""}</tr></thead><tbody>${rows.map(s=>{const c=customers.find(c=>String(c.id)===String(s.pelanggan_id));return `<tr><td class="bold">${esc(s.nomor_nota||"—")}</td><td>${new Date(s.tanggal||s.created_at).toLocaleString("id-ID")}</td><td>${esc(c?.nama||s.recipient_name||"Pelanggan umum")}</td><td>${esc(({cash:"Tunai",transfer:"Transfer",qris:"QRIS",debit:"Debit"})[s.metode_pembayaran]||s.metode_pembayaran||"—")}</td><td>${money(s.diskon)}</td><td class="bold">${money(s.total)}</td><td><span class="status-pill ${saleStatusClass(s.status)}">${esc(saleStatusLabel(s))}</span></td>${actions?`<td><div class="actions"><button class="table-action" data-print-sale="${esc(s.id)}" title="Cetak nota" aria-label="Cetak nota ${esc(s.nomor_nota)}"><i class="fa-solid fa-print"></i></button>${!s.recipient_name&&!["dibatalkan","gagal_dikirim"].includes(s.status)?`<button class="table-action danger" data-cancel-sale="${esc(s.id)}" title="Batalkan transaksi"><i class="fa-solid fa-rotate-left"></i></button>`:""}</div></td>`:""}</tr>`}).join("")}</tbody></table>`}
function renderDeliveryOrders(){
 const orders=sales.filter(s=>s.channel==="delivery").sort((a,b)=>String(b.tanggal).localeCompare(String(a.tanggal)));
 const pending=orders.filter(order=>order.status==="menunggu").length,count=$("#deliveryCount");
 if(count){count.textContent=pending;count.classList.toggle("hidden",pending===0);}
 const labels={menunggu:"Menunggu konfirmasi",diproses:"Sedang Diproses",dalam_pengiriman:"Dalam Pengiriman",selesai:"Selesai — Sudah Sampai",gagal_dikirim:"Gagal Dikirim",dibatalkan:"Ditolak / dibatalkan"};
 $("#deliveryOrders").innerHTML=orders.length?`<table class="data-table"><thead><tr><th>NOMOR PESANAN</th><th>TANGGAL PESANAN</th><th>TANGGAL PENGIRIMAN</th><th>PELANGGAN</th><th>ITEM</th><th>ALAMAT & CATATAN</th><th>TOTAL</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody>${orders.map(order=>{
  const customer=customers.find(row=>String(row.id)===String(order.pelanggan_id));
  const items=(order.items||[]).map(item=>`${esc(item.name||item.nama_barang)} × ${Number(item.qty||item.jumlah)}`).join("<br>");
  const statusActions=order.status==="menunggu"?`<div class="delivery-actions"><button class="btn-secondary delivery-status-action" data-delivery-status="diproses" data-delivery-id="${esc(order.id)}">Sedang Diproses</button><button class="btn-secondary delivery-status-action danger" data-delivery-status="dibatalkan" data-delivery-id="${esc(order.id)}">Tolak Pesanan</button></div>`:order.status==="diproses"?`<div class="delivery-actions"><button class="btn-secondary delivery-status-action" data-delivery-status="dalam_pengiriman" data-delivery-id="${esc(order.id)}">Dalam Pengiriman</button><button class="btn-primary delivery-status-action" data-delivery-status="selesai" data-delivery-current="diproses" data-delivery-id="${esc(order.id)}"><i class="fa-solid fa-circle-check"></i> Selesaikan Pengantaran</button></div>`:order.status==="dalam_pengiriman"?`<div class="delivery-actions"><button class="btn-primary delivery-status-action" data-delivery-status="selesai" data-delivery-current="dalam_pengiriman" data-delivery-id="${esc(order.id)}"><i class="fa-solid fa-circle-check"></i> Selesaikan Pengantaran</button><button class="btn-secondary delivery-status-action danger" data-delivery-status="gagal_dikirim" data-delivery-id="${esc(order.id)}">Gagal Dikirim</button></div>`:"";
  const actions=`<div class="delivery-actions"><button class="table-action" data-print-sale="${esc(order.id)}" title="Cetak nota"><i class="fa-solid fa-print"></i></button>${statusActions}</div>`;
  const deliveryDate=order.tanggal_pengiriman?new Date(order.tanggal_pengiriman).toLocaleString("id-ID"):"Belum dikirim";
  return `<tr><td class="bold">${esc(order.nomor_nota)}</td><td>${new Date(order.tanggal).toLocaleString("id-ID")}</td><td>${deliveryDate}</td><td>${esc(order.recipient_name||customer?.nama||"Pelanggan")}<br>${esc(order.recipient_phone||customer?.telepon||"")}</td><td>${items}</td><td>${esc(order.delivery_address||customer?.alamat||"—")}${order.delivery_note?`<br><small>${esc(order.delivery_note)}</small>`:""}</td><td class="bold">${money(order.total)}</td><td><span class="status-pill ${["dibatalkan","gagal_dikirim"].includes(order.status)?"cancelled":order.status==="selesai"?"done":"pending"}">${esc(labels[order.status]||order.status)}</span></td><td>${actions}</td></tr>`;
 }).join("")}</tbody></table>`:empty("Belum ada pesanan antar","Pesanan pelanggan yang masuk akan tampil di sini.");
}
async function updateDeliveryOrder(id,status){
 await requestDeliveryStatus(id,status);
 await loadData();
}
async function requestDeliveryStatus(id,status){
 const {error}=await db().rpc("update_delivery_status",{p_sale_id:id,p_status:status});
 if(error){
  const details=error.message||"Kesalahan tidak diketahui.";
  if(["dalam_pengiriman","gagal_dikirim"].includes(status))throw new Error(`Status ini memerlukan migrasi backend/sql/07_delivery_tracking.sql dan 09_accounting_ledger.sql. Pastikan migrasi telah diterapkan dan status pesanan masih valid. Detail: ${details}`);
  throw new Error(details);
 }
}
async function completeDeliveryOrder(id,currentStatus){
 if(currentStatus==="diproses"){
  await requestDeliveryStatus(id,"dalam_pengiriman");
  try{await requestDeliveryStatus(id,"selesai")}
  catch(error){
   await loadData();
   throw new Error(`Pesanan sudah dipindahkan ke Dalam Pengiriman, tetapi belum dapat diselesaikan: ${error.message}`);
  }
  await loadData();
  return;
 }
 await updateDeliveryOrder(id,"selesai");
}
async function handleDeliveryAction(action,id,button,currentStatus){
 if(button)button.disabled=true;
 try{
  if(action==="dibatalkan"&&!confirm("Tolak pesanan ini dan kembalikan stok?"))return;
  if(action==="gagal_dikirim"&&!confirm("Tandai gagal dikirim dan kembalikan stok yang sudah dipesan?"))return;
  if(action==="selesai"&&!confirm("Konfirmasi barang sudah diterima pelanggan? Status pengantaran akan diselesaikan; pembayaran tetap dicatat terpisah."))return;
  if(action==="selesai")await completeDeliveryOrder(id,currentStatus);
  else await updateDeliveryOrder(id,action);
  toast(({diproses:"Pesanan dikonfirmasi dan mulai diproses.",dalam_pengiriman:"Pesanan ditandai dalam pengiriman.",selesai:"Pengantaran selesai. Status pembayaran tidak diubah.",gagal_dikirim:"Pengiriman gagal dan stok dikembalikan.",dibatalkan:"Pesanan ditolak dan stok dikembalikan."})[action]||"Status pesanan diperbarui.");
 }catch(error){toast(error.message||"Status pesanan gagal diperbarui.",true);}
 finally{if(button)button.disabled=false}
}
function validateReportPeriod(){const from=$("#reportFrom").value,to=$("#reportTo").value;if(from&&to&&from>to)throw new Error("Tanggal mulai laporan tidak boleh setelah tanggal akhir.")}
function inReportPeriod(value){validateReportPeriod();const d=dateKey(value),from=$("#reportFrom").value,to=$("#reportTo").value;return(!from||d>=from)&&(!to||d<=to)}
function reportRows(){return [...sales].filter(s=>inReportPeriod(s.tanggal||s.created_at)).sort((a,b)=>String(b.tanggal||b.created_at).localeCompare(String(a.tanggal||a.created_at)))}
function reportPurchases(){return purchases.filter(p=>inReportPeriod(p.tanggal||p.created_at)).sort((a,b)=>String(b.tanggal||b.created_at).localeCompare(String(a.tanggal||a.created_at)))}
function reportExpenses(){return expenses.filter(x=>inReportPeriod(x.tanggal||x.created_at)).sort((a,b)=>String(b.tanggal||b.created_at).localeCompare(String(a.tanggal||a.created_at)))}
function reportStockMovements(){return stockMovements.filter(x=>inReportPeriod(x.tanggal||x.created_at)).sort((a,b)=>String(b.tanggal||b.created_at).localeCompare(String(a.tanggal||a.created_at)))}
function completedSales(rows=reportRows()){return rows.filter(s=>s.status==="selesai"&&(!s.status_pembayaran||s.status_pembayaran==="lunas"))}
function saleCost(s){
 const details=saleItems.filter(i=>String(i.penjualan_id)===String(s.id));
 if(details.length){if(details.some(i=>i.harga_pokok_satuan==null))return null;return details.reduce((sum,i)=>sum+Number(i.jumlah||0)*Number(i.harga_pokok_satuan),0)}
 const items=s.items||[];
 if(!items.length||items.some(i=>i.cost==null&&i.harga_pokok_satuan==null))return null;
 return items.reduce((sum,i)=>sum+Number(i.qty||i.jumlah||0)*Number(i.cost??i.harga_pokok_satuan),0);
}
function productPerformanceRows(validSales){
 const salesById=new Map(validSales.map(sale=>[String(sale.id),sale])),totals=new Map();
 for(const item of saleItems){
  const sale=salesById.get(String(item.penjualan_id));
  if(!sale)continue;
  const key=String(item.barang_id||item.sku||item.nama_barang);
  const subtotal=Number(item.subtotal??Number(item.jumlah||0)*Number(item.harga_satuan||0));
  const quantity=Number(item.jumlah||0);
  const bucket=totals.get(key)||{sku:item.sku||"",name:item.nama_barang||"Barang",quantity:0,gross:0,net:0,cost:0,costComplete:true};
  const sourceSubtotal=Number(sale.subtotal||0);
  const discountFactor=sourceSubtotal>0?Math.max(0,sourceSubtotal-Number(sale.diskon||0))/sourceSubtotal:1;
  bucket.quantity+=quantity;
  bucket.gross+=subtotal;
  bucket.net+=subtotal*discountFactor;
  if(item.harga_pokok_satuan==null)bucket.costComplete=false;
  else bucket.cost+=quantity*Number(item.harga_pokok_satuan);
  totals.set(key,bucket);
 }
 return [...totals.values()].map(row=>({...row,margin:row.costComplete?row.net-row.cost:null})).sort((a,b)=>b.net-a.net);
}
function expenseCategoryRows(rows=reportExpenses()){
 const totals=new Map();
 for(const expense of rows){const name=expense.kategori||"Lainnya",bucket=totals.get(name)||{name,count:0,total:0};bucket.count++;bucket.total+=Number(expense.nominal||0);totals.set(name,bucket)}
 return [...totals.values()].sort((a,b)=>b.total-a.total);
}
function inventoryValuationRows(){
 return products.map(product=>({...product,nilai:productValue(product)})).sort((a,b)=>b.nilai-a.nilai);
}
function stockMovementRows(){
 return reportStockMovements().map(movement=>({...movement,product:products.find(product=>String(product.id)===String(movement.barang_id))}));
}
function reportTable(rows,headers,renderRow,emptyTitle,emptyDescription){return rows.length?`<table class="data-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(renderRow).join("")}</tbody></table>`:empty(emptyTitle,emptyDescription)}
function renderSalesReport(){
 if(window.RetailFinancialReports){
  window.RetailFinancialReports.render({sales,purchases,expenses,stockMovements,products,saleItems,customers,accounting:accountingData});
  return;
 }
 $("#reportCashflow").textContent="Tidak tersedia";
 const rows=reportRows(),valid=completedSales(rows),purchasesInPeriod=reportPurchases(),expensesInPeriod=reportExpenses();
 const revenue=valid.reduce((sum,s)=>sum+Number(s.total||0),0),saleCosts=valid.map(saleCost),costsComplete=saleCosts.every(cost=>cost!==null),cogs=costsComplete?saleCosts.reduce((sum,cost)=>sum+cost,0):null,gross=cogs===null?null:revenue-cogs,expenseTotal=expensesInPeriod.reduce((sum,x)=>sum+Number(x.nominal||0),0),purchaseTotal=purchasesInPeriod.reduce((sum,p)=>sum+Number(p.total||Number(p.jumlah||0)*Number(p.harga_satuan||0)),0),net=gross===null?null:gross-expenseTotal;
 $("#legacyCostNotice").classList.toggle("hidden",costsComplete);$("#reportCount").textContent=valid.length;$("#reportRevenue").textContent=money(revenue);$("#reportCost").textContent=cogs===null?"Data belum lengkap":money(cogs);$("#reportGrossProfit").textContent=gross===null?"Data belum lengkap":money(gross);$("#reportExpenses").textContent=money(expenseTotal);$("#reportNetProfit").textContent=net===null?"Data belum lengkap":money(net);$("#reportPurchases").textContent=money(purchaseTotal);$("#reportCashflow").textContent=money(revenue-purchaseTotal-expenseTotal);$("#reportDiscount").textContent=money(valid.reduce((sum,s)=>sum+Number(s.diskon||0),0));
 $("#reportCashflow").textContent="Tidak tersedia";
 $("#incomeStatement").innerHTML=reportTable([
  {label:"Penjualan sebelum diskon",amount:valid.reduce((sum,s)=>sum+Number(s.subtotal||0),0)},
  {label:"Diskon penjualan",amount:-valid.reduce((sum,s)=>sum+Number(s.diskon||0),0)},
  {label:"Penjualan bersih",amount:revenue,emphasis:true},
  {label:"Harga pokok penjualan (HPP)",amount:cogs===null?null:-cogs},
  {label:"Laba kotor",amount:gross,emphasis:true},
  {label:"Beban operasional",amount:-expenseTotal},
  {label:"Laba bersih",amount:net,emphasis:true}
 ],["KETERANGAN","NOMINAL"],r=>`<tr><td class="${r.emphasis?"bold":""}">${r.label}</td><td class="${r.emphasis?"bold":""}">${r.amount===null?"Data belum lengkap":money(r.amount)}</td></tr>`,"Belum ada transaksi pada periode ini","Laporan laba rugi akan tampil setelah ada transaksi atau beban.");
 const methods=[["cash","Tunai"],["transfer","Transfer"],["qris","QRIS"],["debit","Kartu debit"]];
 $("#paymentBreakdown").innerHTML=reportTable(methods.map(([key,label])=>({label,rows:valid.filter(s=>s.metode_pembayaran===key)})).filter(m=>m.rows.length).map(m=>({label:m.label,count:m.rows.length,total:m.rows.reduce((sum,s)=>sum+Number(s.total||0),0)})),["METODE PEMBAYARAN","TRANSAKSI","PENJUALAN BERSIH"],r=>`<tr><td>${r.label}</td><td>${r.count}</td><td class="bold">${money(r.total)}</td></tr>`,"Belum ada penerimaan","Belum ada transaksi lunas pada periode ini.");
 const productRows=productPerformanceRows(valid);
 $("#productPerformance").innerHTML=reportTable(productRows,["SKU","BARANG","TERJUAL","PENJUALAN SETELAH ALOKASI DISKON","HPP","LABA KOTOR"],row=>`<tr><td>${esc(row.sku||"—")}</td><td class="bold">${esc(row.name)}</td><td>${row.quantity}</td><td>${money(row.net)}</td><td>${row.costComplete?money(row.cost):"Data belum lengkap"}</td><td class="bold">${row.margin===null?"Data belum lengkap":money(row.margin)}</td></tr>`,"Belum ada rincian barang terjual","Rincian per barang akan tampil untuk transaksi selesai pada periode ini.");
 const expenseRows=expenseCategoryRows(expensesInPeriod);
 $("#expenseBreakdown").innerHTML=reportTable(expenseRows,["KATEGORI","JUMLAH CATATAN","TOTAL BEBAN"],row=>`<tr><td>${esc(row.name)}</td><td>${row.count}</td><td class="bold">${money(row.total)}</td></tr>`,"Belum ada beban","Catat beban operasional agar rekap kategori tersedia.");
 $("#salesTable").innerHTML=salesTable(rows,true);
 $("#purchasesTable").innerHTML=reportTable(purchasesInPeriod,["TANGGAL","BARANG","JUMLAH","HARGA BELI","TOTAL","CATATAN"],p=>{const product=products.find(x=>String(x.id)===String(p.barang_id));return `<tr><td>${new Date(p.tanggal||p.created_at).toLocaleString("id-ID")}</td><td>${esc(product?.nama||"Barang")}</td><td>${Number(p.jumlah||0)} ${esc(product?.satuan||"")}</td><td>${money(p.harga_satuan)}</td><td class="bold">${money(p.total??Number(p.jumlah||0)*Number(p.harga_satuan||0))}</td><td>${esc(p.catatan||"—")}</td></tr>`},"Belum ada pembelian","Catatan stok masuk akan muncul di sini.");
 $("#expensesTable").innerHTML=reportTable(expensesInPeriod,["TANGGAL","KATEGORI","KETERANGAN","NOMINAL","AKSI"],x=>`<tr><td>${new Date(x.tanggal||x.created_at).toLocaleDateString("id-ID")}</td><td>${esc(x.kategori)}</td><td>${esc(x.keterangan)}</td><td class="bold">${money(x.nominal)}</td><td><button class="table-action danger" data-delete-expense="${esc(x.id)}" title="Hapus beban"><i class="fa-solid fa-trash"></i></button></td></tr>`,"Belum ada beban operasional","Catat biaya toko untuk menghitung laba bersih.");
 const movements=stockMovementRows(),movementLabels={saldo_awal:"Saldo awal",pembelian:"Stok masuk",reservasi_pesanan:"Reservasi pesanan",penjualan:"Penjualan",penyesuaian:"Penyesuaian",pembatalan:"Pembatalan"};
 $("#stockMovementsTable").innerHTML=reportTable(movements,["TANGGAL","BARANG","JENIS","REFERENSI","MASUK","KELUAR","SALDO SETELAH","CATATAN"],row=>`<tr><td>${new Date(row.tanggal||row.created_at).toLocaleString("id-ID")}</td><td>${esc(row.product?.nama||row.barang_id||"Barang")}</td><td>${esc(movementLabels[row.tipe]||row.tipe||"—")}</td><td>${esc(row.referensi||"—")}</td><td>${Number(row.qty_masuk||0)}</td><td>${Number(row.qty_keluar||0)}</td><td>${Number(row.stok_setelah||0)} ${esc(row.product?.satuan||"")}</td><td>${esc(row.catatan||"—")}</td></tr>`,"Belum ada mutasi stok","Tidak ada mutasi persediaan pada periode yang dipilih.");
 const valuation=inventoryValuationRows();
 $("#inventoryValuation").innerHTML=reportTable(valuation,["SKU","BARANG","STOK SAAT INI","BIAYA RATA-RATA TERCATAT","NILAI STOK","BATAS MINIMUM","STATUS"],row=>`<tr><td>${esc(row.sku)}</td><td class="bold">${esc(row.nama)}</td><td>${Number(row.stok||0)} ${esc(row.satuan)}</td><td>${money(row.harga_beli)}</td><td class="bold">${money(row.nilai)}</td><td>${Number(row.stok_minimum||0)} ${esc(row.satuan)}</td><td><span class="stock-badge ${Number(row.stok)<=Number(row.stok_minimum)?"low":"ok"}">${Number(row.stok)<=Number(row.stok_minimum)?"Menipis":"Aman"}</span></td></tr>`,"Belum ada barang aktif","Tambah barang untuk melihat valuasi persediaan saat ini.");
}
function applyReportFilters(){try{renderSalesReport()}catch(error){toast(error.message||"Filter laporan tidak valid.",true)}}
let pendingProductPhoto=null,removeProductPhoto=false;
function renderPhotoPreview(photo){const preview=$("#productPhotoPreview"),image=$("#productPhotoPreviewImage");pendingProductPhoto=photo||null;image.src=photo||"";preview.classList.toggle("hidden",!photo);$("#removeProductPhoto").classList.toggle("hidden",!photo);$("#chooseProductPhoto").innerHTML=`<i class="fa-solid fa-camera"></i> ${photo?"Ganti foto":"Pilih foto"}`;}
function openProduct(p=null){$("#productForm").reset();$("#productError").classList.add("hidden");$("#productId").value=p?p.id:"";$("#productModalTitle").textContent=p?"Edit barang":"Tambah barang";$("#stockQty").disabled=!!p;if(p){$("#sku").value=p.sku;$("#productName").value=p.nama;$("#productCategory").value=p.kategori;$("#unit").value=p.satuan;$("#buyPrice").value=p.harga_beli;$("#sellPrice").value=p.harga_jual;$("#stockQty").value=p.stok;$("#minStock").value=p.stok_minimum;}else{$("#stockQty").disabled=false;$("#stockQty").value=0;$("#minStock").value=5;}removeProductPhoto=false;renderPhotoPreview(p?.foto_url||null);$("#productDialog").showModal()}
function processProductPhoto(file){
 if(!file)return Promise.resolve(null);
 if(!["image/jpeg","image/png","image/webp"].includes(file.type))return Promise.reject(new Error("Format foto harus JPG, PNG, atau WebP."));
 if(file.size>4*1024*1024)return Promise.reject(new Error("Ukuran foto maksimal 4 MB."));
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error("File foto tidak dapat dibaca. Coba pilih gambar lain."));
  reader.onload=()=>{
   const image=new Image();
   image.onerror=()=>reject(new Error("File bukan gambar yang valid atau gambar rusak."));
   image.onload=()=>{
    try{
     const scale=Math.min(1,1200/Math.max(image.naturalWidth,image.naturalHeight));
     const canvas=document.createElement("canvas");
     canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
     canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
     const context=canvas.getContext("2d");
     if(!context)throw new Error("Browser tidak dapat memproses foto.");
     context.drawImage(image,0,0,canvas.width,canvas.height);
     let output=canvas.toDataURL("image/webp",0.82);
     if(!output.startsWith("data:image/webp;"))output=canvas.toDataURL("image/jpeg",0.82);
     if(output.length>900000)throw new Error("Foto masih terlalu besar setelah dikompres. Pilih gambar yang lebih sederhana.");
     resolve(output);
    }catch(error){reject(error);}
   };
   image.src=String(reader.result);
  };
  reader.readAsDataURL(file);
 });
}
async function selectProductPhoto(event){
 const file=event.target.files?.[0];
 if(!file)return;
 const saveButton=$("#productForm").querySelector('[type="submit"]');
 saveButton.disabled=true;
 $("#productError").classList.add("hidden");
 try{
  const photo=await processProductPhoto(file);
  renderPhotoPreview(photo);
  removeProductPhoto=false;
 }catch(error){
  const current=products.find(product=>String(product.id)===$("#productId").value);
  renderPhotoPreview(current?.foto_data||null);
  event.target.value="";
  $("#productError").textContent=error.message||"Foto tidak dapat diproses.";
  $("#productError").classList.remove("hidden");
 }finally{saveButton.disabled=false;}
}
async function uploadProductPhoto(dataUrl){
 const blob=await fetch(dataUrl).then(response=>response.blob());
 const extension=blob.type==="image/webp"?"webp":"jpg";
 const randomId=globalThis.crypto?.randomUUID?globalThis.crypto.randomUUID():globalThis.crypto?.getRandomValues?Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,"0")).join(""):null;
 if(!randomId)throw new Error("Browser tidak menyediakan generator acak aman. Buka aplikasi melalui HTTPS atau localhost untuk mengunggah foto.");
 const path=`${randomId}.${extension}`;
 const {error}=await db().storage.from("product-photos").upload(path,blob,{contentType:blob.type,upsert:false});
 if(error){
  const message=String(error.message||"");
  if(/bucket.*not found|not found.*bucket/i.test(message))throw new Error("Penyimpanan foto Supabase belum disiapkan. Administrator perlu menjalankan backend/sql/06_app_operations.sql di SQL Editor Supabase.");
  if(/row-level security|permission|not authorized|unauthorized/i.test(message))throw new Error("Supabase menolak unggahan foto. Pastikan Anda login sebagai Owner dan kebijakan Storage dari backend/sql/06_app_operations.sql sudah diterapkan.");
  throw new Error(`Foto gagal diunggah ke Supabase Storage: ${message||"periksa konfigurasi bucket dan koneksi."}`);
 }
 return {path,url:db().storage.from("product-photos").getPublicUrl(path).data.publicUrl};
}
async function removeProductPhotoObject(publicUrl){
 if(!publicUrl)return;
 const marker="/object/public/product-photos/";
 const position=publicUrl.indexOf(marker);
 if(position<0)return;
 const path=decodeURIComponent(publicUrl.slice(position+marker.length));
 const {error}=await db().storage.from("product-photos").remove([path]);
 if(error)throw new Error(error.message||"Foto lama gagal dihapus dari Supabase Storage.");
}
function productFormData(){const d={sku:$("#sku").value.trim(),nama:$("#productName").value.trim(),kategori:$("#productCategory").value,satuan:$("#unit").value,harga_beli:Number($("#buyPrice").value),harga_jual:Number($("#sellPrice").value),stok:Number($("#stockQty").value),stok_minimum:Number($("#minStock").value),aktif:true};if(!d.sku||!d.nama||!d.kategori)throw Error("Lengkapi semua data wajib.");if([d.harga_beli,d.harga_jual,d.stok,d.stok_minimum].some(n=>!Number.isFinite(n)||n<0))throw Error("Harga dan stok tidak boleh negatif.");return d}
function productCsvTemplate(){csv("template-impor-barang-toko-budi.csv",[["sku","nama","kategori","satuan","harga_beli","harga_jual","stok_awal","batas_minimum"]])}
function parseProductCsv(text){
 const source=String(text||"").replace(/^\uFEFF/,"");
 let comma=0,semicolon=0,quoted=false;
 for(const char of source){if(char==='"')quoted=!quoted;else if(!quoted&&char==="\n")break;else if(!quoted&&char===",")comma++;else if(!quoted&&char===";")semicolon++}
 const delimiter=semicolon>comma?";":",",rows=[];let row=[],cell="",insideQuotes=false;
 for(let i=0;i<source.length;i++){
  const char=source[i];
  if(char==='"'&&insideQuotes&&source[i+1]==='"'){cell+='"';i++}
  else if(char==='"')insideQuotes=!insideQuotes;
  else if(char===delimiter&&!insideQuotes){row.push(cell);cell=""}
  else if((char==="\n"||char==="\r")&&!insideQuotes){
   if(char==="\r"&&source[i+1]==="\n")i++;
   row.push(cell);if(row.some(value=>value.trim()!==""))rows.push(row);row=[];cell="";
  }else cell+=char;
 }
 if(insideQuotes)throw Error("CSV memiliki tanda kutip yang belum ditutup.");
 row.push(cell);if(row.some(value=>value.trim()!==""))rows.push(row);
 if(rows.length<2)throw Error("CSV harus memiliki header dan minimal satu baris barang.");
 const normalize=value=>String(value||"").trim().toLowerCase().replace(/[\s-]+/g,"_");
 const aliases={sku:["sku","kode_barang"],nama:["nama","nama_barang"],kategori:["kategori"],satuan:["satuan","unit"],harga_beli:["harga_beli","harga_beli_per_satuan"],harga_jual:["harga_jual","harga_jual_per_satuan"],stok_awal:["stok_awal","stok"],batas_minimum:["batas_minimum","stok_minimum","minimum_stok"]};
 const header=rows[0].map(normalize),columns={};
 for(const [field,names] of Object.entries(aliases)){columns[field]=header.findIndex(value=>names.includes(value));if(columns[field]<0)throw Error(`Kolom wajib "${field}" tidak ditemukan. Unduh template CSV untuk format yang benar.`)}
 if(rows.length-1>500)throw Error("Impor dibatasi 500 barang per berkas.");
 const skuSet=new Set(products.map(product=>String(product.sku||"").trim().toLowerCase()));
 const decimal=value=>{const clean=String(value||"").trim();return Number(delimiter===";"?clean.replace(",","."):clean)};
 return rows.slice(1).map((values,index)=>{
  const line=index+2,get=field=>String(values[columns[field]]??"").trim();
  const product={sku:get("sku"),nama:get("nama"),kategori:get("kategori"),satuan:get("satuan"),harga_beli:decimal(get("harga_beli")),harga_jual:decimal(get("harga_jual")),stok:decimal(get("stok_awal")),stok_minimum:decimal(get("batas_minimum")),aktif:true};
  if(!product.sku||product.sku.length>50)throw Error(`Baris ${line}: SKU wajib diisi dan maksimal 50 karakter.`);
  if(!product.nama||product.nama.length>150||!product.kategori||!product.satuan)throw Error(`Baris ${line}: nama, kategori, dan satuan wajib diisi.`);
  if([product.harga_beli,product.harga_jual,product.stok,product.stok_minimum].some(value=>!Number.isFinite(value)||value<0))throw Error(`Baris ${line}: harga dan stok harus berupa angka nol atau lebih.`);
  if(product.stok!==0)throw Error(`Baris ${line}: stok awal CSV harus 0. Catat stok melalui saldo awal terverifikasi atau transaksi stok masuk.`);
  const key=product.sku.toLowerCase();if(skuSet.has(key))throw Error(`Baris ${line}: SKU "${product.sku}" sudah ada atau berulang.`);
  skuSet.add(key);return product;
 });
}
async function importProductsFile(event){
 const file=event.target.files?.[0];if(!file)return;
 const input=event.target,button=$("#importProductsButton");
 button.disabled=true;
 try{
  if(file.size>1024*1024)throw Error("Ukuran CSV maksimal 1 MB.");
  const productsToImport=parseProductCsv(await file.text());
  if(!confirm(`Impor ${productsToImport.length} barang dengan harga dan stok yang tercantum pada CSV? Data akan disimpan ke Supabase.`))return;
  await checked(db().from("barang").insert(productsToImport));
  await loadData();toast(`${productsToImport.length} barang berhasil diimpor.`);
 }catch(error){toast(error.message||"Impor barang gagal.",true)}
 finally{input.value="";button.disabled=false}
}
async function saveProduct(e){
 e.preventDefault();
 const button=e.submitter;
 if(button)button.disabled=true;
 let uploaded=null,productSaved=false;
 try{
  const values=productFormData(),id=$("#productId").value,current=products.find(p=>String(p.id)===String(id));
  if(!id&&values.stok!==0)throw Error("Barang baru harus dibuat dengan stok 0. Catat jumlah barang melalui stok masuk atau saldo awal terverifikasi.");
  if(current&&Number(current.stok)>0&&accountingData.settings?.opening_entry_id&&Number(values.harga_beli)!==Number(current.harga_beli))throw Error("Biaya rata-rata barang dengan stok tidak dapat diubah langsung setelah saldo awal dicatat. Catat stok masuk atau jurnal koreksi.");
  if(products.some(p=>p.sku.toLowerCase()===values.sku.toLowerCase()&&String(p.id)!==String(id)))throw Error("SKU sudah digunakan.");
  let fotoUrl=removeProductPhoto?null:current?.foto_url||null;
  if(pendingProductPhoto&&pendingProductPhoto!==current?.foto_url){
   uploaded=await uploadProductPhoto(pendingProductPhoto);
   fotoUrl=uploaded.url;
  }
  const payload={sku:values.sku,nama:values.nama,kategori:values.kategori,satuan:values.satuan,harga_beli:values.harga_beli,harga_jual:values.harga_jual,stok_minimum:values.stok_minimum,aktif:true,foto_url:fotoUrl};
  if(id)await checked(db().from("barang").update(payload).eq("id",id));
  else await checked(db().from("barang").insert({...payload,stok:values.stok}));
  productSaved=true;
  if(current?.foto_url&&current.foto_url!==fotoUrl){
   try{await removeProductPhotoObject(current.foto_url)}catch(error){toast(`Barang tersimpan, tetapi foto lama belum terhapus: ${error.message}`,true)}
  }
  await loadData();
  $("#productDialog").close();
  toast(id?"Barang diperbarui.":"Barang ditambahkan.");
 }catch(err){
  let message=err.message||"Gagal menyimpan barang";
  if(uploaded&&!productSaved){
   try{
    const {error:cleanupError}=await db().storage.from("product-photos").remove([uploaded.path]);
    if(cleanupError)message+=` Foto sementara juga gagal dibersihkan: ${cleanupError.message}`;
   }catch(cleanupError){message+=` Foto sementara juga gagal dibersihkan: ${cleanupError.message||"periksa Storage Supabase."}`}
  }
  if(productSaved)message=`Barang tersimpan, tetapi daftar gagal dimuat ulang: ${message}`;
  $("#productError").textContent=message;
  $("#productError").classList.remove("hidden");
 }finally{if(button)button.disabled=false}
}
function openCustomer(c=null){$("#customerForm").reset();$("#customerError").classList.add("hidden");$("#customerId").value=c?c.id:"";$("#customerModalTitle").textContent=c?"Edit pelanggan":"Tambah pelanggan";if(c){$("#customerName").value=c.nama;$("#customerPhone").value=c.telepon||"";$("#customerAddress").value=c.alamat||""}$("#customerDialog").showModal()}
async function saveCustomer(e){e.preventDefault();try{const d={nama:$("#customerName").value.trim(),telepon:$("#customerPhone").value.trim()||null,alamat:$("#customerAddress").value.trim()||null},id=$("#customerId").value;if(!d.nama)throw Error("Nama pelanggan wajib diisi.");if(id)await checked(db().from("pelanggan").update(d).eq("id",id));else await checked(db().from("pelanggan").insert(d));await loadData();$("#customerDialog").close();toast("Data pelanggan disimpan.")}catch(err){$("#customerError").textContent=err.message;$("#customerError").classList.remove("hidden")}}
function openExpense(){const form=$("#expenseForm");form.reset();$("#expenseError").classList.add("hidden");$("#expenseDate").value=todayISO();$("#expensePaidAmount").value=0;$("#expenseRequestKey").value=requestKey();$("#expenseDialog").showModal()}
async function saveExpense(e){
 e.preventDefault();
 const date=$("#expenseDate").value,category=$("#expenseCategory").value,description=$("#expenseDescription").value.trim(),amount=Number($("#expenseAmount").value);
 try{
  const paidAmount=Number($("#expensePaidAmount").value),paymentMethod=$("#expensePaymentMethod").value;
  if(!date||!category||!description||!Number.isFinite(amount)||amount<=0||!Number.isFinite(paidAmount)||paidAmount<0||paidAmount>amount)throw Error("Lengkapi tanggal, kategori, keterangan, nominal, serta pembayaran antara Rp0 dan total beban.");
  await checked(db().rpc("record_operational_expense",{
   p_date:date,p_category:category,p_description:description,p_amount:amount,
   p_paid_amount:paidAmount,p_payment_method:paymentMethod,p_request_key:$("#expenseRequestKey").value
  }));await loadData();
  $("#expenseDialog").close();toast("Beban operasional berhasil dicatat.");
 }catch(err){$("#expenseError").textContent=err.message||"Gagal menyimpan beban operasional.";$("#expenseError").classList.remove("hidden");}
}
async function deleteExpense(id){
 toast("Catatan beban yang sudah dijurnal tidak dapat dihapus. Buat jurnal koreksi agar riwayat tetap dapat diaudit.",true);
}
function openAccountingPayment(kind,sourceId,balance){
 const definitions={
  customer_receipt:["Catat pembayaran piutang","Pembayaran pelanggan masuk ke Kas atau Bank."],
  customer_refund:["Catat pengembalian dana","Pembayaran refund mengurangi utang pengembalian pelanggan."],
  supplier_payment:["Bayar utang pemasok","Pembayaran mengurangi utang pemasok dan saldo Kas/Bank."],
  expense_payment:["Bayar utang beban","Pembayaran mengurangi utang beban operasional."]
 };
 const [title,description]=definitions[kind]||[];
 if(!title||!sourceId||!Number.isFinite(Number(balance))||Number(balance)<=0)return;
 $("#accountingPaymentTitle").textContent=title;
 $("#accountingPaymentDescription").textContent=description;
 $("#accountingPaymentKind").value=kind;
 $("#accountingPaymentSource").value=sourceId;
 $("#accountingPaymentDate").value=todayISO();
 $("#accountingPaymentRequestKey").value=requestKey();
 $("#accountingPaymentAmount").value=Number(balance).toFixed(2);
 $("#accountingPaymentAmount").max=Number(balance).toFixed(2);
 $("#accountingPaymentMethod").value="cash";
 $("#accountingPaymentError").classList.add("hidden");
 $("#accountingPaymentDialog").showModal();
}
async function submitAccountingPayment(event){
 event.preventDefault();
 const kind=$("#accountingPaymentKind").value,sourceId=$("#accountingPaymentSource").value;
 const amount=Number($("#accountingPaymentAmount").value),date=$("#accountingPaymentDate").value;
 const method=$("#accountingPaymentMethod").value;
 const error=$("#accountingPaymentError"),button=event.submitter;
 error.classList.add("hidden");if(button)button.disabled=true;
 try{
  if(!date||!Number.isFinite(amount)||amount<=0||amount>Number($("#accountingPaymentAmount").max))throw Error("Tanggal atau nominal pembayaran tidak valid.");
  if(kind==="customer_receipt")await checked(db().rpc("record_customer_payment",{p_sale_id:sourceId,p_amount:amount,p_payment_method:method,p_payment_date:date,p_request_key:$("#accountingPaymentRequestKey").value}));
  else if(kind==="customer_refund")await checked(db().rpc("record_customer_refund",{p_sale_id:sourceId,p_amount:amount,p_payment_method:method,p_payment_date:date,p_request_key:$("#accountingPaymentRequestKey").value}));
  else await checked(db().rpc("record_supplier_or_expense_payment",{p_kind:kind,p_source_id:sourceId,p_amount:amount,p_payment_method:method,p_payment_date:date,p_request_key:$("#accountingPaymentRequestKey").value}));
  await loadData();$("#accountingPaymentDialog").close();toast("Pembayaran dan jurnal berhasil dicatat.");
 }catch(err){error.textContent=err.message||"Pembayaran gagal dicatat.";error.classList.remove("hidden");}
 finally{if(button)button.disabled=false}
}
function accountingSelectOptions(accounts,selected=""){
 return accounts.filter(account=>account.is_active).map(account=>`<option value="${esc(account.code)}"${account.code===selected?" selected":""}>${esc(account.code)} — ${esc(account.name)}</option>`).join("");
}
function accountingLineRow(accounts,opening=false,openingBalance=null){
 if(opening){
  const typeLabels={asset:"Aset",liability:"Liabilitas",equity:"Ekuitas"};
  return `<div class="accounting-line opening-balance-line" data-opening-account="${esc(accounts.code)}" data-normal-balance="${esc(accounts.normal_balance)}"><span><b class="accounting-account">${esc(accounts.code)} — ${esc(accounts.name)}</b><small>${typeLabels[accounts.account_type]||esc(accounts.account_type)}</small></span><span>${accounts.normal_balance==="debit"?"Debit":"Kredit"}</span><input class="control" type="number" min="0" step="0.01" data-opening-debit aria-label="Saldo debit ${esc(accounts.name)}" placeholder="Belum diketahui" value="${esc(openingBalance?.debit??"")}"><input class="control" type="number" min="0" step="0.01" data-opening-credit aria-label="Saldo kredit ${esc(accounts.name)}" placeholder="Belum diketahui" value="${esc(openingBalance?.credit??"")}"></div>`;
 }
 return `<div class="accounting-line" data-manual-line><select class="control" data-manual-account required><option value="">Pilih akun</option>${accountingSelectOptions(accounts)}</select><input class="control" type="number" min="0" step="0.01" data-manual-debit aria-label="Debit" placeholder="Debit"><input class="control" type="number" min="0" step="0.01" data-manual-credit aria-label="Kredit" placeholder="Kredit"><button type="button" class="table-action danger" data-remove-journal-line aria-label="Hapus baris">×</button></div>`;
}
function setupAccountingTools(){
 $("#openOpeningBalances").addEventListener("click",()=>{
  if(accountingData.error||accountingData.openingDraftError||accountingData.settings?.opening_entry_id)return;
  const date=accountingData.settings.cutover_date;
  const draft=accountingData.openingDraft;
  $("#openingBalancesDate").textContent=`Tanggal cutover / jurnal pembukaan: ${date}. Jurnal ini akan menjadi saldo pembuka, bukan penerimaan kas periode berjalan.`;
  $("#openingBalanceSource").value=draft?.supporting_source||"";
  $("#openingBalanceReference").value=draft?.reference_number||"";
  const draftLines=new Map((draft?.lines||[]).map(line=>[String(line.account_code),line]));
  $("#openingBalanceLines").innerHTML=accountingData.accounts
   .filter(account=>account.is_active&&["asset","liability","equity"].includes(account.account_type))
   .map(account=>{
    const line=draftLines.get(String(account.code));
    return accountingLineRow(account,true,line);
   }).join("");
  const missing=accountingData.accounts.filter(account=>{
   if(!account.is_active||!["asset","liability","equity"].includes(account.account_type))return false;
   const line=draftLines.get(String(account.code));
   return !line||(line.debit==null||line.debit==="")&&(line.credit==null||line.credit==="");
  }).map(account=>account.code);
  $("#openingBalanceDraftStatus").textContent=draft?.posted_entry_id
   ? "Saldo awal sudah diposting; draft dikunci."
   : draft ? `Draft tersimpan pada ${new Date(draft.updated_at).toLocaleString("id-ID")}.${missing.length?` Akun yang belum tersimpan: ${missing.join(", ")}.`:""} Kolom kosong tetap belum diketahui.`
    : "Belum ada draft. Kolom saldo dibiarkan kosong sampai nilainya diperiksa.";
  $("#openingBalanceError").classList.add("hidden");$("#openingBalancesDialog").showModal();
 });
 $("#openingBalancesForm").addEventListener("submit",async event=>{
  event.preventDefault();const error=$("#openingBalanceError"),button=event.submitter;
  error.classList.add("hidden");if(button)button.disabled=true;
  try{
   const rows=[...$("#openingBalanceLines").querySelectorAll("[data-opening-account]")];
   const lines=rows.map(row=>{
    const debit=row.querySelector("[data-opening-debit]").value.trim();
    const credit=row.querySelector("[data-opening-credit]").value.trim();
    return {account_code:row.dataset.openingAccount,debit,credit,normal_balance:row.dataset.normalBalance};
   });
   const payload=lines.map(({normal_balance,...line})=>({
    account_code:line.account_code,debit:line.debit||null,credit:line.credit||null
   }));
   const source=$("#openingBalanceSource").value.trim();
   const reference=$("#openingBalanceReference").value.trim();
   if(button?.value==="draft"){
    await checked(db().rpc("save_accounting_opening_draft",{
     p_lines:payload,p_supporting_source:source||null,p_reference_number:reference||null
    }));
    await loadData();$("#openingBalancesDialog").close();toast("Draft saldo awal tersimpan; belum memengaruhi laporan.");
    return;
   }
   if(!source)throw Error("Sumber saldo atau keterangan pendukung wajib diisi sebelum posting.");
   const incomplete=lines.filter(line=>line.debit===""&&line.credit==="").map(line=>line.account_code);
   if(incomplete.length)throw Error(`Lengkapi semua akun neraca. Isi 0 jika saldo memang tidak ada. Belum lengkap: ${incomplete.join(", ")}.`);
   const postLines=lines.map(line=>{
    const debit=line.debit===""?0:Number(line.debit);
    const credit=line.credit===""?0:Number(line.credit);
    if(!Number.isFinite(debit)||!Number.isFinite(credit)||debit<0||credit<0||(debit>0&&credit>0))throw Error(`Nominal akun ${line.account_code} tidak valid; isi satu posisi saldo saja.`);
    if(debit>0&&line.normal_balance!=="debit")throw Error(`Akun ${line.account_code} bersaldo normal kredit; periksa posisinya.`);
    if(credit>0&&line.normal_balance!=="credit")throw Error(`Akun ${line.account_code} bersaldo normal debit; periksa posisinya.`);
    return {account_code:line.account_code,debit,credit};
   });
   const debit=postLines.reduce((total,line)=>total+line.debit,0),credit=postLines.reduce((total,line)=>total+line.credit,0);
   if(debit<=0||Math.abs(debit-credit)>0.005)throw Error(`Saldo awal harus seimbang. Debit ${money(debit)}; kredit ${money(credit)}. Tidak ada nilai penyeimbang otomatis.`);
   await checked(db().rpc("post_accounting_opening_balances",{
    p_lines:postLines,p_supporting_source:source,p_reference_number:reference||null
   }));
   await loadData();$("#openingBalancesDialog").close();toast("Saldo awal berhasil diposting dan tercatat di buku besar.");
  }catch(err){error.textContent=err.message||"Saldo awal gagal disimpan.";error.classList.remove("hidden");}
  finally{if(button)button.disabled=false}
 });
 const addManualLine=()=>$("#manualJournalLines").insertAdjacentHTML("beforeend",accountingLineRow(accountingData.accounts));
 $("#openManualJournal").addEventListener("click",()=>{
  if(accountingData.error)return;
  $("#manualJournalForm").reset();$("#manualJournalDate").value=todayISO();
  $("#manualJournalRequestKey").value=requestKey();
  $("#manualJournalLines").innerHTML="";addManualLine();addManualLine();
  $("#manualJournalError").classList.add("hidden");$("#manualJournalDialog").showModal();
 });
 $("#addManualJournalLine").addEventListener("click",addManualLine);
 $("#manualJournalLines").addEventListener("click",event=>{
  if(event.target.closest("[data-remove-journal-line]")&&$("#manualJournalLines").querySelectorAll("[data-manual-line]").length>2)event.target.closest("[data-manual-line]").remove();
 });
 $("#manualJournalForm").addEventListener("submit",async event=>{
  event.preventDefault();const error=$("#manualJournalError"),button=event.submitter;
  error.classList.add("hidden");if(button)button.disabled=true;
  try{
   const lines=[...$("#manualJournalLines").querySelectorAll("[data-manual-line]")].map(row=>({
    account_code:row.querySelector("[data-manual-account]").value,
    debit:Number(row.querySelector("[data-manual-debit]").value||0),
    credit:Number(row.querySelector("[data-manual-credit]").value||0)
   })).filter(line=>line.account_code&&(line.debit||line.credit));
   const debit=lines.reduce((total,line)=>total+line.debit,0),credit=lines.reduce((total,line)=>total+line.credit,0);
   if(!$("#manualJournalDate").value||!$("#manualJournalDescription").value.trim()||lines.length<2||debit<=0||Math.abs(debit-credit)>0.005)throw Error(`Jurnal harus memuat keterangan, minimal dua baris, dan debit sama dengan kredit. Debit ${money(debit)}; kredit ${money(credit)}.`);
   await checked(db().rpc("post_accounting_manual_journal",{p_date:$("#manualJournalDate").value,p_description:$("#manualJournalDescription").value.trim(),p_cash_flow_activity:$("#manualJournalActivity").value,p_lines:lines,p_request_key:$("#manualJournalRequestKey").value}));
   await loadData();$("#manualJournalDialog").close();toast("Jurnal manual berhasil diposting.");
  }catch(err){error.textContent=err.message||"Jurnal manual gagal diposting.";error.classList.remove("hidden");}
  finally{if(button)button.disabled=false}
 });
 $("#openCashReconciliation").addEventListener("click",()=>{
  $("#cashReconciliationForm").reset();$("#reconciliationDate").value=todayISO();
  $("#reconciliationRequestKey").value=requestKey();
  $("#reconciliationError").classList.add("hidden");$("#cashReconciliationDialog").showModal();
 });
 $("#cashReconciliationForm").addEventListener("submit",async event=>{
  event.preventDefault();const error=$("#reconciliationError"),button=event.submitter;
  error.classList.add("hidden");if(button)button.disabled=true;
  try{
   const balance=Number($("#reconciliationBalance").value);
   if(!Number.isFinite(balance)||!$("#reconciliationDate").value||!$("#reconciliationNote").value.trim())throw Error("Tanggal, saldo, dan catatan rekening koran wajib diisi.");
   await checked(db().rpc("record_account_reconciliation",{p_account_code:$("#reconciliationAccount").value,p_statement_date:$("#reconciliationDate").value,p_statement_balance:balance,p_note:$("#reconciliationNote").value.trim(),p_request_key:$("#reconciliationRequestKey").value}));
   await loadData();$("#cashReconciliationDialog").close();toast("Saldo rekening koran tersimpan; periksa nilai selisih pada laporan.");
  }catch(err){error.textContent=err.message||"Rekonsiliasi gagal disimpan.";error.classList.remove("hidden");}
  finally{if(button)button.disabled=false}
 });
 $("#accountingPaymentForm").addEventListener("submit",submitAccountingPayment);
 document.addEventListener("click",event=>{
  const button=event.target.closest("[data-record-customer-payment],[data-record-customer-refund],[data-record-obligation-payment]");
  if(!button)return;
  if(button.dataset.recordCustomerPayment)openAccountingPayment("customer_receipt",button.dataset.recordCustomerPayment,Number(button.dataset.paymentBalance));
  else if(button.dataset.recordCustomerRefund)openAccountingPayment("customer_refund",button.dataset.recordCustomerRefund,Number(button.dataset.paymentBalance));
  else openAccountingPayment(button.dataset.recordObligationPayment,button.dataset.obligationId,Number(button.dataset.paymentBalance));
 });
}
async function deleteProduct(id){const p=products.find(p=>String(p.id)===id);if(!p)return;if(!confirm(`Nonaktifkan ${p.nama}? Barang tidak lagi ditampilkan di katalog/kasir, tetapi data transaksi dan stoknya tetap tersimpan.`))return;try{await checked(db().from("barang").update({aktif:false}).eq("id",id));cart=cart.filter(x=>String(x.id)!==id);await loadData();toast("Barang dinonaktifkan.")}catch(e){toast("Tidak bisa menonaktifkan barang: "+e.message,true)}}
async function deleteCustomer(id){if(sales.some(s=>String(s.pelanggan_id)===id)){toast("Pelanggan terkait transaksi. Edit data atau pertahankan untuk riwayat.",true);return}if(!confirm("Hapus pelanggan ini?"))return;try{await checked(db().from("pelanggan").delete().eq("id",id));await loadData();toast("Pelanggan dihapus.")}catch(e){toast(e.message,true)}}
function addCart(id){const p=products.find(p=>String(p.id)===String(id));if(!p)return;const current=cart.find(x=>String(x.id)===String(id));if(current){if(current.qty+1>Number(p.stok)){toast("Jumlah melebihi stok tersedia.",true);return}current.qty++}else cart.push({id:p.id,name:p.nama,sku:p.sku,unit:p.satuan,price:Number(p.harga_jual),qty:1,stock:Number(p.stok)});renderCart()}
function changeCart(id,delta){const item=cart.find(x=>String(x.id)===String(id));if(!item)return;const p=products.find(p=>String(p.id)===String(id));item.qty+=delta;if(item.qty<1)cart=cart.filter(x=>String(x.id)!==String(id));else if(p&&item.qty>Number(p.stok)){item.qty=Number(p.stok);toast("Jumlah melebihi stok tersedia.",true)}renderCart()}
async function checkout(){
 if(!cart.length)return;
 const subtotal=cart.reduce((sum,item)=>sum+item.qty*item.price,0),discount=Math.max(0,Number($("#saleDiscount").value||0)),total=subtotal-Math.min(discount,subtotal),paid=Math.max(0,Number($("#amountPaid").value||0));
 if(discount>subtotal){toast("Diskon tidak boleh melebihi subtotal.",true);return}
 if(paid<total){toast("Jumlah dibayar kurang dari total tagihan.",true);return}
 if(!confirm(`Simpan penjualan sebesar ${money(total)}?`))return;
 $("#checkoutButton").disabled=true;
 try{
  const result=await checked(db().rpc("create_sale",{
   p_customer_id:$("#saleCustomer").value||null,p_discount:discount,p_payment_method:$("#paymentMethod").value,
   p_amount_paid:paid,p_items:cart.map(item=>({product_id:item.id,qty:item.qty}))
  }));
  cart=[];$("#saleDiscount").value=0;$("#amountPaid").value=0;
  await loadData();
  toast(`Penjualan tersimpan: ${result.nomor_nota}`);
  page("reports");
 }catch(error){toast("Transaksi gagal: "+(error.message||"Kesalahan tidak diketahui"),true)}
 finally{$("#checkoutButton").disabled=!cart.length}
}
function csv(filename,rows){const body=rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\r\n");const url=URL.createObjectURL(new Blob(["\ufeff"+body],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}
function excel(filename,sheets){
 if(!window.XLSX){toast("Ekspor Excel tidak tersedia. Periksa koneksi internet lalu muat ulang halaman.",true);return}
 try{const workbook=window.XLSX.utils.book_new();for(const sheet of sheets){const worksheet=window.XLSX.utils.aoa_to_sheet(sheet.rows);window.XLSX.utils.book_append_sheet(workbook,worksheet,sheet.name)}window.XLSX.writeFile(workbook,filename,{compression:true})}
 catch(err){toast("Gagal membuat berkas Excel: "+err.message,true)}
}
function runReportExport(exporter){try{exporter()}catch(error){toast(error.message||"Laporan tidak dapat diekspor.",true)}}
function exportProducts(){csv("laporan-persediaan.csv",[["SKU","Nama","Kategori","Satuan","Harga Beli","Harga Jual","Stok","Stok Minimum","Nilai Persediaan"],...products.map(p=>[p.sku,p.nama,p.kategori,p.satuan,p.harga_beli,p.harga_jual,p.stok,p.stok_minimum,productValue(p)])])}
function exportCustomers(){csv("data-pelanggan.csv",[["Nama","Telepon","Alamat"],...customers.map(c=>[c.nama,c.telepon,c.alamat])])}
function exportSales(){if(!window.RetailFinancialReports)throw new Error("Modul laporan belum tersedia. Muat ulang sebelum mengekspor.");const valid=completedSales(),costs=valid.map(saleCost),complete=costs.every(cost=>cost!==null),revenue=valid.reduce((sum,sale)=>sum+Number(sale.total||0),0),cogs=complete?costs.reduce((sum,cost)=>sum+cost,0):null,expenseTotal=reportExpenses().reduce((sum,row)=>sum+Number(row.nominal||0),0),purchaseTotal=reportPurchases().reduce((sum,row)=>sum+Number(row.total??Number(row.jumlah||0)*Number(row.harga_satuan||0)),0);const rows=[["RINGKASAN LAPORAN — TOKO BUDI SEMBAKO"],["Dari tanggal",$("#reportFrom").value||"Semua tanggal"],["Sampai tanggal",$("#reportTo").value||"Semua tanggal"],["Status HPP",complete?"Lengkap":"Tidak lengkap — tinjau transaksi lama"],["Penjualan bersih",revenue],["Harga pokok penjualan",cogs],["Laba kotor",cogs===null?null:revenue-cogs],["Beban operasional",expenseTotal],["Laba bersih",cogs===null?null:revenue-cogs-expenseTotal],["Pembelian persediaan",purchaseTotal],["Arus kas operasional estimasi",revenue-purchaseTotal-expenseTotal],[],["PENJUALAN"],["Nomor Nota","Tanggal","Pelanggan","Subtotal","Diskon","Total","Metode","Dibayar","Kembalian","HPP","Status"],...reportRows().map(s=>[s.nomor_nota,s.tanggal,customers.find(c=>String(c.id)===String(s.pelanggan_id))?.nama||s.recipient_name||"Pelanggan umum",s.subtotal,s.diskon,s.total,s.metode_pembayaran,s.jumlah_dibayar,s.kembalian,saleCost(s),s.status]),[],["PENJUALAN PER BARANG"],["SKU","Barang","Qty","Penjualan setelah alokasi diskon","HPP","Laba kotor"],...productPerformanceRows(completedSales()).map(row=>[row.sku,row.name,row.quantity,row.net,row.costComplete?row.cost:null,row.margin]),[],["PEMBELIAN PERSEDIAAN"],["Tanggal","Barang","Jumlah","Harga Satuan","Total","Catatan"],...reportPurchases().map(p=>[p.tanggal,products.find(x=>String(x.id)===String(p.barang_id))?.nama||"Barang",p.jumlah,p.harga_satuan,p.total??Number(p.jumlah||0)*Number(p.harga_satuan||0),p.catatan]),[],["BEBAN OPERASIONAL"],["Tanggal","Kategori","Keterangan","Nominal"],...reportExpenses().map(x=>[x.tanggal,x.kategori,x.keterangan,x.nominal]),[],["BEBAN PER KATEGORI"],["Kategori","Jumlah Catatan","Total"],...expenseCategoryRows().map(row=>[row.name,row.count,row.total]),[],["MUTASI PERSEDIAAN"],["Tanggal","SKU","Barang","Jenis","Referensi","Masuk","Keluar","Saldo setelah","Catatan"],...stockMovementRows().map(row=>[row.tanggal,row.product?.sku||"",row.product?.nama||"",row.tipe,row.referensi,row.qty_masuk,row.qty_keluar,row.stok_setelah,row.catatan]),[],["VALUASI PERSEDIAAN SAAT INI (bukan saldo historis)"],["SKU","Barang","Satuan","Stok saat ini","Biaya rata-rata tercatat","Nilai stok","Batas minimum"],...inventoryValuationRows().map(row=>[row.sku,row.nama,row.satuan,row.stok,row.harga_beli,row.nilai,row.stok_minimum])];csv("laporan-keuangan-dan-persediaan-toko-budi-sembako.csv",rows)}
function exportProductsExcel(){excel("persediaan-toko-budi-sembako.xlsx",[{name:"Persediaan",rows:[["SKU","Nama Barang","Kategori","Satuan","Harga Beli (Rp)","Harga Jual (Rp)","Stok","Stok Minimum","Nilai Persediaan (Rp)"],...activeProducts().map(p=>[p.sku,p.nama,p.kategori,p.satuan,Number(p.harga_beli),Number(p.harga_jual),Number(p.stok),Number(p.stok_minimum),productValue(p)])]}])}
function exportCustomersExcel(){excel("pelanggan-toko-budi-sembako.xlsx",[{name:"Pelanggan",rows:[["Nama","Telepon","Alamat"],...customers.map(c=>[c.nama,c.telepon||"",c.alamat||""])]}])}
function exportSalesExcel(){
 if(!window.RetailFinancialReports)throw new Error("Modul laporan belum tersedia. Muat ulang sebelum mengekspor.");
 const valid=completedSales();
 const saleCosts=valid.map(saleCost),costsComplete=saleCosts.every(cost=>cost!==null),revenue=valid.reduce((sum,s)=>sum+Number(s.total||0),0),cogs=costsComplete?saleCosts.reduce((sum,cost)=>sum+cost,0):null,expensesTotal=reportExpenses().reduce((sum,x)=>sum+Number(x.nominal||0),0),purchaseTotal=reportPurchases().reduce((sum,p)=>sum+Number(p.total??Number(p.jumlah||0)*Number(p.harga_satuan||0)),0);
 const methods=[["cash","Tunai"],["transfer","Transfer"],["qris","QRIS"],["debit","Kartu debit"]];
 const summary=[["LAPORAN KEUANGAN TOKO BUDI SEMBAKO"],["Periode mulai",$("#reportFrom").value||"Semua tanggal"],["Periode sampai",$("#reportTo").value||"Semua tanggal"],["Status HPP",costsComplete?"Lengkap":"Tidak lengkap — tinjau transaksi lama"],[],["Keterangan","Nominal (Rp)"],["Jumlah transaksi",valid.length],["Penjualan sebelum diskon",valid.reduce((sum,s)=>sum+Number(s.subtotal||0),0)],["Diskon penjualan",valid.reduce((sum,s)=>sum+Number(s.diskon||0),0)],["Penjualan bersih",revenue],["Harga pokok penjualan",cogs],["Laba kotor",cogs===null?null:revenue-cogs],["Beban operasional",expensesTotal],["Laba bersih",cogs===null?null:revenue-cogs-expensesTotal],["Pembelian persediaan",purchaseTotal],["Arus kas bersih",revenue-purchaseTotal-expensesTotal]];
 const salesRows=[["Nomor Nota","Tanggal","Pelanggan","Subtotal (Rp)","Diskon (Rp)","Total (Rp)","Metode Pembayaran","Dibayar (Rp)","Kembalian (Rp)","HPP (Rp)","Status Penjualan","Status Pembayaran"],...reportRows().map(s=>[s.nomor_nota,s.tanggal,customers.find(c=>String(c.id)===String(s.pelanggan_id))?.nama||s.recipient_name||"Pelanggan umum",Number(s.subtotal||0),Number(s.diskon||0),Number(s.total||0),s.metode_pembayaran,Number(s.jumlah_dibayar||0),Number(s.kembalian||0),saleCost(s),s.status,s.status_pembayaran||"lunas"])];
 const purchaseRows=[["Tanggal","Barang","Jumlah","Satuan","Harga Satuan (Rp)","Total (Rp)","Catatan"],...reportPurchases().map(p=>{const product=products.find(x=>String(x.id)===String(p.barang_id));return[p.tanggal,product?.nama||"Barang",Number(p.jumlah||0),product?.satuan||"",Number(p.harga_satuan||0),Number(p.total??Number(p.jumlah||0)*Number(p.harga_satuan||0)),p.catatan||""]})];
 const expenseRows=[["Tanggal","Kategori","Keterangan","Nominal (Rp)"],...reportExpenses().map(x=>[x.tanggal,x.kategori,x.keterangan,Number(x.nominal||0)])];
 const paymentRows=[["Metode Pembayaran","Jumlah Transaksi","Penjualan Bersih (Rp)"],...methods.map(([key,label])=>{const methodSales=valid.filter(s=>s.metode_pembayaran===key);return[label,methodSales.length,methodSales.reduce((sum,s)=>sum+Number(s.total||0),0)]})];
 const productRows=[["SKU","Barang","Qty Terjual","Penjualan Setelah Alokasi Diskon (Rp)","HPP (Rp)","Laba Kotor (Rp)"],...productPerformanceRows(valid).map(row=>[row.sku,row.name,row.quantity,row.net,row.costComplete?row.cost:null,row.margin])];
 const categoryRows=[["Kategori","Jumlah Catatan","Total Beban (Rp)"],...expenseCategoryRows().map(row=>[row.name,row.count,row.total])];
 const movementRows=[["Tanggal","SKU","Barang","Jenis","Referensi","Masuk","Keluar","Saldo Setelah","Catatan"],...stockMovementRows().map(row=>[row.tanggal,row.product?.sku||"",row.product?.nama||"",row.tipe,row.referensi,row.qty_masuk,row.qty_keluar,row.stok_setelah,row.catatan])];
 const valuationRows=[["SKU","Barang","Satuan","Stok Saat Ini","Biaya Rata-rata Tercatat (Rp)","Nilai Saat Ini (Rp)","Batas Minimum"],...inventoryValuationRows().map(row=>[row.sku,row.nama,row.satuan,Number(row.stok||0),Number(row.harga_beli||0),row.nilai,Number(row.stok_minimum||0)])];
 excel("laporan-keuangan-dan-persediaan-toko-budi-sembako.xlsx",[{name:"Laba Rugi",rows:summary},{name:"Penjualan",rows:salesRows},{name:"Penjualan per Barang",rows:productRows},{name:"Pembelian Stok",rows:purchaseRows},{name:"Beban Operasional",rows:expenseRows},{name:"Beban per Kategori",rows:categoryRows},{name:"Metode Pembayaran",rows:paymentRows},{name:"Mutasi Stok",rows:movementRows},{name:"Valuasi Saat Ini",rows:valuationRows}]);
}
async function submitStockIn(e){e.preventDefault();$("#stockInError").classList.add("hidden");const id=$("#stockInProduct").value,qty=Number($("#stockInQty").value),cost=Number($("#stockInCost").value),paid=Number($("#stockInPaymentAmount").value),method=$("#stockInPaymentMethod").value,note=$("#stockInNote").value.trim();try{if(!id||!Number.isFinite(qty)||qty<=0||!Number.isFinite(cost)||cost<=0||!Number.isFinite(paid)||paid<0||paid>qty*cost)throw Error("Pilih barang dan masukkan jumlah, biaya, serta pembayaran yang valid; pembayaran tidak boleh melebihi nilai stok masuk.");await checked(db().rpc("record_stock_in",{p_product_id:id,p_qty:qty,p_unit_cost:cost,p_note:note||null,p_paid_amount:paid,p_payment_method:method,p_request_key:$("#stockInRequestKey").value}));await loadData();$("#stockInDialog").close();$("#stockInForm").reset();toast("Pembelian stok dan jurnal berhasil dicatat.");}catch(err){$("#stockInError").textContent=err.message||"Gagal mencatat stok masuk." ;$("#stockInError").classList.remove("hidden")}}
async function cancelSale(id){if(!confirm("Batalkan transaksi ini dan kembalikan stok?"))return;try{await checked(db().rpc("cancel_sale",{p_sale_id:id}));await loadData();toast("Transaksi dibatalkan dan stok dikembalikan.")}catch(e){toast("Pembatalan gagal: "+e.message,true)}}
function setup(){
 const disclaimer=$(".disclaimer"),footerNote=$(".footer span");
 if(disclaimer)disclaimer.textContent="Transaksi diproses secara aman dan disimpan di Supabase.";
 if(footerNote)footerNote.textContent="HTML · CSS · JavaScript · Supabase";
 $("#today").textContent=new Intl.DateTimeFormat("id-ID",{day:"numeric",month:"short",year:"numeric"}).format(new Date());
 $$(".nav-item").forEach(b=>b.addEventListener("click",()=>page(b.dataset.page)));$$("[data-goto]").forEach(b=>b.addEventListener("click",()=>page(b.dataset.goto)));
 $("#addProduct").onclick=()=>openProduct();$("#downloadProductTemplate").onclick=productCsvTemplate;$("#importProductsButton").onclick=()=>$("#importProductsFile").click();$("#importProductsFile").addEventListener("change",importProductsFile);$("#stockInButton").onclick=()=>{if(!products.length){toast("Tambahkan master barang terlebih dahulu.",true);return;}populateStockInProducts();$("#stockInForm").reset();$("#stockInPaymentAmount").value=0;$("#stockInRequestKey").value=requestKey();populateStockInProducts();$("#stockInError").classList.add("hidden");$("#stockInDialog").showModal()};$("#stockInForm").addEventListener("submit",submitStockIn);$("#stockInProduct").addEventListener("change",()=>{const p=products.find(p=>String(p.id)===$("#stockInProduct").value);if(p)$("#stockInCost").value=p.harga_beli});$("#productForm").addEventListener("submit",saveProduct);$("#chooseProductPhoto").onclick=()=>$("#productPhoto").click();$("#productPhoto").addEventListener("change",selectProductPhoto);$("#removeProductPhoto").onclick=()=>{removeProductPhoto=true;renderPhotoPreview(null);$("#productPhoto").value="";};$("#productSearch").addEventListener("input",renderProducts);$("#stockFilter").addEventListener("change",renderProducts);
 $("#productsTable").addEventListener("click",e=>{const edit=e.target.closest("[data-edit-product]"),del=e.target.closest("[data-delete-product]");if(edit)openProduct(products.find(p=>String(p.id)===edit.dataset.editProduct));if(del)deleteProduct(del.dataset.deleteProduct)});
 $("#saleSearch").addEventListener("input",renderSaleProducts);$("#saleProductGrid").addEventListener("click",e=>{const b=e.target.closest("[data-add-cart]");if(b)addCart(b.dataset.addCart)});
 $("#cartItems").addEventListener("click",e=>{const minus=e.target.closest("[data-cart-minus]"),plus=e.target.closest("[data-cart-plus]"),remove=e.target.closest("[data-cart-remove]");if(minus)changeCart(minus.dataset.cartMinus,-1);if(plus)changeCart(plus.dataset.cartPlus,1);if(remove){cart=cart.filter(x=>String(x.id)!==remove.dataset.cartRemove);renderCart()}});
 $("#clearCart").onclick=()=>{cart=[];renderCart()};$("#saleDiscount").addEventListener("input",renderCart);$("#amountPaid").addEventListener("input",renderCart);$("#checkoutButton").onclick=checkout;
 $("#addCustomer").onclick=()=>openCustomer();$("#customerForm").addEventListener("submit",saveCustomer);$("#customerSearch").addEventListener("input",renderCustomers);$("#customersTable").addEventListener("click",e=>{const edit=e.target.closest("[data-edit-customer]"),del=e.target.closest("[data-delete-customer]");if(edit)openCustomer(customers.find(c=>String(c.id)===edit.dataset.editCustomer));if(del)deleteCustomer(del.dataset.deleteCustomer)});
 $("#applyReport").onclick=applyReportFilters;$("#resetReport").onclick=()=>{$("#reportFrom").value="";$("#reportTo").value="";applyReportFilters()};$("#salesTable").addEventListener("click",e=>{const b=e.target.closest("[data-cancel-sale]");if(b)cancelSale(b.dataset.cancelSale)});
 $("#addExpense").onclick=openExpense;$("#expenseForm").addEventListener("submit",saveExpense);$("#expensesTable").addEventListener("click",e=>{const b=e.target.closest("[data-delete-expense]");if(b)deleteExpense(b.dataset.deleteExpense)});
 $("#exportProducts").onclick=exportProducts;$("#exportProductsExcel").onclick=exportProductsExcel;$("#exportCustomers").onclick=exportCustomers;$("#exportCustomersExcel").onclick=exportCustomersExcel;$("#exportSales").onclick=()=>runReportExport(exportSales);$("#exportSalesExcel").onclick=()=>runReportExport(exportSalesExcel);
 $("#refreshDelivery").onclick=()=>loadData().catch(error=>{statusConnection(false);toast("Pesanan gagal dimuat: "+error.message,true)});$("#deliveryOrders").addEventListener("click",event=>{const button=event.target.closest("[data-delivery-status]");if(button)handleDeliveryAction(button.dataset.deliveryStatus,button.dataset.deliveryId,button,button.dataset.deliveryCurrent)});
 if(window.RetailFinancialReports){
  $("#exportSales").onclick=null;
  $("#exportSalesExcel").onclick=null;
  window.RetailFinancialReports.setup({
   getData:()=>({sales,purchases,expenses,stockMovements,products,saleItems,customers,accounting:accountingData}),
   refresh:async()=>{try{await loadData()}catch(error){statusConnection(false);throw error}},
   notify:toast
  });
 }
 setupAccountingTools();
 document.addEventListener("click",handlePrintReceiptClick);
 $("#logoutButton").onclick=logout;
 $$("[data-close]").forEach(b=>b.addEventListener("click",()=>$("#"+b.dataset.close).close()));
 $("#openSidebar").onclick=()=>{$("#sidebar").classList.add("open");$("#scrim").classList.add("show")};$("#closeSidebar").onclick=$("#scrim").onclick=()=>{$("#sidebar").classList.remove("open");$("#scrim").classList.remove("show")};
}
async function logout(){
 try{await window.RetailAuth.signOut();location.replace("login.html")}
 catch(error){toast(error.message||"Logout gagal.",true)}
}
async function init(){
 let user;
 try{user=await withTimeout(window.RetailAuth.getCurrentUser(),12000,"Pemeriksaan sesi Supabase terlalu lama. Masuk kembali; data transaksi Anda tidak dihapus.");}
 catch(error){
  const url=new URL("login.html",location.href);
  url.searchParams.set("notice",error.code==="AUTH_CONNECTION_TIMEOUT"?"AUTH_CONNECTION_TIMEOUT":error.code||"AUTH_SESSION_INVALID");
  location.replace(url);
  return;
 }
 if(!user){location.replace("login.html");return;}
 if(user.role!=="owner"){location.replace("customer.html");return;}
 setup();
 statusConnection();
 try{await loadData();}
 catch(error){statusConnection(false);window.RetailFinancialReports?.setError(error.message);toast("Data Supabase tidak dapat dimuat: "+error.message,true);}
 window.RetailAuth.onAuthStateChange(event=>{
  if(event==="SIGNED_OUT")location.replace("login.html");
 });
 window.addEventListener("focus",()=>loadData().catch(error=>{statusConnection(false);window.RetailFinancialReports?.setError(error.message);toast("Sinkronisasi Supabase gagal: "+error.message,true)}));
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});
else init();
})();