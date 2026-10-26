(() => {
  "use strict";

  const $=selector=>document.querySelector(selector);
  const money=value=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(Number(value)||0);
  const esc=value=>String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
  let user=null,products=[],orders=[],cart=[],checkoutRequestId=null,toastTimer;
  const db=()=>window.RetailConfig.getClient();
  async function checked(result){
    const {data,error}=await result;
    if(error)throw new Error(error.message||"Permintaan ke Supabase gagal.");
    return data;
  }

  function toast(text,error=false){
    const element=$("#toast");
    element.textContent=text;
    element.className="toast show"+(error?" error":"");
    clearTimeout(toastTimer);
    toastTimer=setTimeout(()=>element.className="toast",3500);
  }
  function showMessage(text,error=false){
    const element=$("#customerMessage");
    element.textContent=text;
    element.classList.toggle("hidden",!text);
    element.classList.toggle("error",error);
  }
  function productImage(product){
    if(product.foto_url)return `<img src="${esc(product.foto_url)}" alt="${esc(product.nama)}" loading="lazy">`;
    if(/^data:image\/(?:webp|png|jpeg);base64,[a-z0-9+/=]+$/i.test(product.foto_data||"")) {
      return `<img src="${esc(product.foto_data)}" alt="${esc(product.nama)}" loading="lazy">`;
    }
    const name=String(product.nama||"").toLowerCase();
    const file=/air mineral|air minum|mineral/.test(name)?"lemineral.jpg":
      /\bmi\b|\bmie\b|noodle/.test(name)?"mie-sedap.jpg":
      /susu|milk/.test(name)?"susu-uht.png":
      /beras|rice/.test(name)?"rice.jpg":
      /minyak|oil/.test(name)?"cooking-oil.jpg":
      /gula|sugar/.test(name)?"sugar.jpg":
      /tepung|flour/.test(name)?"flour.jpg":"";
    return file?`<img src="../assets/products/${file}" alt="${esc(product.nama)}" loading="lazy" onerror="this.hidden=true">`:
      '<span class="customer-no-image"><i class="fa-solid fa-box"></i></span>';
  }
  function renderCatalog(){
    const query=$("#catalogSearch").value.trim().toLowerCase(),category=$("#categoryFilter").value;
    const rows=products.filter(product=>product.aktif!==false&&(!category||product.kategori===category)&&
      [product.nama,product.kategori,product.sku].some(value=>String(value||"").toLowerCase().includes(query)));
    $("#catalog").innerHTML=rows.length?rows.map(product=>`
      <article class="customer-product"><div class="customer-product-image">${productImage(product)}</div>
        <div class="customer-product-info"><small>${esc(product.kategori)}</small><h3>${esc(product.nama)}</h3>
          <span class="customer-availability">${Number(product.stok)>0?`Tersedia · ${Number(product.stok)} ${esc(product.satuan)}`:"Stok habis"}</span>
          <b>${money(product.harga_jual)} <small>/ ${esc(product.satuan)}</small></b>
          <button class="btn-primary" type="button" data-add-product="${esc(product.id)}" ${Number(product.stok)<=0?"disabled":""}>Tambah ke keranjang</button>
        </div>
      </article>`).join(""):'<div class="empty"><i class="fa-solid fa-box-open"></i><b>Produk tidak ditemukan</b><p>Ubah pencarian atau filter kategori Anda.</p></div>';
  }
  function renderCart(){
    $("#cartCount").textContent=`${cart.reduce((sum,item)=>sum+item.qty,0)} produk`;
    $("#cartTotal").textContent=money(cart.reduce((sum,item)=>sum+item.qty*item.price,0));
    $("#checkoutButton").disabled=!cart.length;
    $("#cartItems").innerHTML=cart.length?cart.map(item=>`
      <div class="customer-cart-item"><div><b>${esc(item.name)}</b><small>${money(item.price)} / ${esc(item.unit)}</small></div>
        <div class="qty-control"><button type="button" data-qty="${esc(item.id)}" data-delta="-1" aria-label="Kurangi">−</button><span>${item.qty}</span><button type="button" data-qty="${esc(item.id)}" data-delta="1" aria-label="Tambah">+</button></div>
        <button type="button" class="remove-item" data-remove="${esc(item.id)}" aria-label="Hapus"><i class="fa-solid fa-xmark"></i></button></div>`).join(""):'<div class="empty"><i class="fa-solid fa-basket-shopping"></i><b>Keranjang kosong</b><p>Pilih produk dari katalog.</p></div>';
  }
  function statusLabel(order){
    return ({menunggu:"Menunggu konfirmasi",diproses:"Sedang diproses",dalam_pengiriman:"Dalam pengiriman",selesai:"Sudah sampai",gagal_dikirim:"Gagal dikirim",dibatalkan:"Ditolak / dibatalkan"})[order.status]||order.status||"—";
  }
  function renderOrders(orders){
    $("#orders").innerHTML=orders.length?`<div class="table-scroll"><table class="data-table"><thead><tr><th>NOMOR PESANAN</th><th>TANGGAL PESANAN</th><th>TANGGAL PENGIRIMAN</th><th>ITEM</th><th>ALAMAT PENGANTARAN</th><th>TOTAL</th><th>STATUS</th><th>AKSI</th></tr></thead><tbody>${orders.map(order=>`
      <tr><td class="bold">${esc(order.nomor_nota)}</td><td>${new Date(order.tanggal).toLocaleDateString("id-ID")}</td>
        <td>${order.tanggal_pengiriman?new Date(order.tanggal_pengiriman).toLocaleString("id-ID"):"Belum dikirim"}</td>
        <td>${(order.items||[]).map(item=>`${esc(item.name)} × ${Number(item.qty)}`).join("<br>")}</td>
        <td>${esc(order.recipient_name)}<br>${esc(order.recipient_phone)}<br>${esc(order.delivery_address)}</td>
        <td>${money(order.total)}</td><td><span class="status-pill ${["dibatalkan","gagal_dikirim"].includes(order.status)?"cancelled":order.status==="selesai"?"done":"pending"}">${statusLabel(order)}</span></td>
        <td><div class="actions"><button class="table-action" type="button" data-print-order="${esc(order.id)}" title="Cetak nota" aria-label="Cetak nota ${esc(order.nomor_nota)}"><i class="fa-solid fa-print"></i></button>${order.status==="menunggu"?`<button class="table-action danger" type="button" data-cancel-order="${esc(order.id)}" title="Batalkan pesanan"><i class="fa-solid fa-xmark"></i></button>`:""}</div></td></tr>`).join("")}</tbody></table></div>`:'<div class="empty"><i class="fa-solid fa-receipt"></i><b>Belum ada pesanan</b><p>Pesanan yang Anda buat akan ditampilkan di sini.</p></div>';
  }
  async function loadCatalog(){
    products=await checked(db().from("customer_catalog").select("*").order("nama"));
    const categories=[...new Set(products.map(product=>product.kategori).filter(Boolean))].sort((a,b)=>a.localeCompare(b,"id"));
    $("#categoryFilter").innerHTML='<option value="">Semua kategori</option>'+categories.map(category=>`<option value="${esc(category)}">${esc(category)}</option>`).join("");
    renderCatalog();
  }
  async function refresh(){
    try{
      const [orderRows,itemRows]=await Promise.all([
        checked(db().from("penjualan").select("*").order("tanggal",{ascending:false})),
        checked(db().from("customer_order_items").select("*"))
      ]);
      await loadCatalog();
      orders=orderRows.filter(order=>order.recipient_name).map(order=>({
        ...order,
        items:itemRows.filter(item=>item.penjualan_id===order.id).map(item=>({
          name:item.nama_barang,sku:item.sku,quantity:item.jumlah,qty:item.jumlah,
          price:item.harga_satuan,subtotal:item.subtotal,
          unit:products.find(product=>String(product.id)===String(item.barang_id))?.satuan||""
        }))
      }));
      renderOrders(orders);
      showMessage("");
    }catch(error){showMessage(`Data Supabase tidak dapat dimuat: ${error.message}`,true);}
  }
  function printOrderReceipt(id){
    const order=orders.find(row=>String(row.id)===String(id));
    if(!order)throw new Error("Pesanan tidak ditemukan pada data akun ini.");
    if(!order.items.length)throw new Error("Detail barang pesanan tidak ditemukan; nota tidak dapat dicetak.");
    window.RetailReceipt.print({
      invoice:order.nomor_nota||order.id,date:new Date(order.tanggal).toLocaleString("id-ID"),
      customer:order.recipient_name||user.displayName||user.email,
      paymentMethod:({cash:"Tunai saat diterima",transfer:"Transfer",qris:"QRIS",debit:"Kartu debit"})[order.metode_pembayaran]||order.metode_pembayaran||"—",
      status:statusLabel(order),deliveryAddress:order.delivery_address||"",
      deliveryDate:order.tanggal_pengiriman?new Date(order.tanggal_pengiriman).toLocaleString("id-ID"):"",
      items:order.items,subtotal:order.subtotal,discount:order.diskon,total:order.total,
      paid:order.jumlah_dibayar,change:order.kembalian,footer:"Terima kasih telah berbelanja di Toko Sembako Budi."
    });
  }
  async function checkout(){
    if(!cart.length)return;
    const recipientName=$("#recipientName").value.trim();
    const recipientPhone=$("#recipientPhone").value.trim();
    const deliveryAddress=$("#deliveryAddress").value.trim();
    if(!recipientName||!recipientPhone||!deliveryAddress){
      toast("Lengkapi nama penerima, nomor telepon, dan alamat pengantaran.",true);
      return;
    }
    const button=$("#checkoutButton");
    button.disabled=true;
    try{
      const updated=await window.RetailAuth.updateProfile({displayName:recipientName,phone:recipientPhone,address:deliveryAddress});
      user=updated;
      const result=await checked(db().rpc("customer_checkout",{
        p_items:cart.map(item=>({product_id:item.id,qty:item.qty})),
        p_payment_method:$("#paymentMethod").value,
        p_request_id:checkoutRequestId||(checkoutRequestId=crypto.randomUUID()),
        p_recipient_name:recipientName,
        p_recipient_phone:recipientPhone,
        p_delivery_address:deliveryAddress,
        p_delivery_note:$("#deliveryNote").value.trim()||null
      }));
      cart=[];
      checkoutRequestId=null;
      $("#deliveryNote").value="";
      await refresh();
      renderCart();
      toast(`Pesanan ${result.nomor_nota} berhasil dikirim dan menunggu konfirmasi Toko.`);
    }catch(error){toast(error.message||"Pesanan gagal dibuat.",true);}
    finally{button.disabled=!cart.length;}
  }
  async function cancelOrder(id){
    if(!confirm("Batalkan pesanan ini? Stok yang dipesan akan dikembalikan."))return;
    try{
      await checked(db().rpc("cancel_customer_order",{p_sale_id:id}));
      await refresh();
      toast("Pesanan dibatalkan dan stok dikembalikan.");
    }catch(error){toast(error.message||"Pesanan gagal dibatalkan.",true);}
  }
  async function saveProfile(event){
    event.preventDefault();
    $("#profileError").classList.add("hidden");
    try{
      const name=$("#profileName").value.trim();
      if(!name)throw new Error("Nama wajib diisi.");
      const updated=await window.RetailAuth.updateProfile({
        displayName:name,
        phone:$("#profilePhone").value,
        address:$("#profileAddress").value
      });
      $("#customerGreeting").textContent=`Halo, ${updated.displayName||updated.email}`;
      $("#recipientName").value=updated.displayName;
      $("#recipientPhone").value=updated.phone;
      $("#deliveryAddress").value=updated.address;
      $("#profileDialog").close();
      toast("Profil pelanggan berhasil diperbarui.");
    }catch(error){$("#profileError").textContent=error.message||"Profil gagal disimpan.";$("#profileError").classList.remove("hidden");}
  }
  function addToCart(id){
    const product=products.find(row=>String(row.id)===String(id));
    if(!product||product.stok<=0){toast("Produk sedang tidak tersedia.",true);return;}
    const item=cart.find(row=>String(row.id)===String(id));
    if(item&&item.qty+1>Number(product.stok)){toast("Jumlah melebihi stok tersedia.",true);return;}
    if(item)item.qty++;
    else cart.push({id:product.id,name:product.nama,unit:product.satuan,price:Number(product.harga_jual),qty:1});
    renderCart();
  }
  async function init(){
    try{user=await window.RetailAuth.getCurrentUser();}
    catch(error){
      const url=new URL("login.html",location.href);
      if(error.code)url.searchParams.set("notice",error.code);
      location.replace(url);
      return;
    }
    if(!user){location.replace("login.html");return;}
    if(user.role!=="customer"){location.replace("index.html");return;}
    $("#customerGreeting").textContent=`Halo, ${user.displayName||user.email}`;
    $("#profileName").value=user.displayName||"";
    $("#profilePhone").value=user.phone||"";
    $("#profileAddress").value=user.address||"";
    $("#recipientName").value=user.displayName||"";
    $("#recipientPhone").value=user.phone||"";
    $("#deliveryAddress").value=user.address||"";
    await refresh();
    window.RetailAuth.onAuthStateChange(event=>{
      if(event==="SIGNED_OUT")location.replace("login.html");
    });
  }

  $("#catalogSearch").addEventListener("input",renderCatalog);
  $("#categoryFilter").addEventListener("change",renderCatalog);
  $("#catalog").addEventListener("click",event=>{const button=event.target.closest("[data-add-product]");if(button)addToCart(button.dataset.addProduct);});
  $("#cartItems").addEventListener("click",event=>{
    const quantity=event.target.closest("[data-qty]"),remove=event.target.closest("[data-remove]");
    if(quantity){
      const item=cart.find(row=>String(row.id)===quantity.dataset.qty),product=products.find(row=>String(row.id)===quantity.dataset.qty);
      if(item){item.qty=Math.max(0,Math.min(Number(product?.stok||0),item.qty+Number(quantity.dataset.delta)));if(!item.qty)cart=cart.filter(row=>row!==item);renderCart();}
    }
    if(remove){cart=cart.filter(row=>String(row.id)!==remove.dataset.remove);renderCart();}
  });
  $("#checkoutButton").addEventListener("click",checkout);
  $("#clearCart").addEventListener("click",()=>{cart=[];renderCart();});
  $("#orders").addEventListener("click",event=>{
    const printButton=event.target.closest("[data-print-order]"),cancelButton=event.target.closest("[data-cancel-order]");
    if(printButton){try{printOrderReceipt(printButton.dataset.printOrder)}catch(error){toast(error.message||"Nota gagal dicetak.",true)}}
    if(cancelButton)cancelOrder(cancelButton.dataset.cancelOrder);
  });
  $("#refreshOrders").addEventListener("click",refresh);
  $("#showProfile").addEventListener("click",()=>$("#profileDialog").showModal());
  $("#profileForm").addEventListener("submit",saveProfile);
  $("#logoutButton").addEventListener("click",async()=>{
    try{await window.RetailAuth.signOut();location.replace("login.html");}
    catch(error){toast(error.message||"Logout gagal.",true);}
  });
  document.querySelectorAll("[data-close]").forEach(button=>button.addEventListener("click",()=>$("#"+button.dataset.close).close()));
  window.addEventListener("focus",()=>refresh());
  document.addEventListener("DOMContentLoaded",init);
})();
