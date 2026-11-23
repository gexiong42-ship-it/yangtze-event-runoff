(() => {
  const contact = document.getElementById('contact-dialog')
  const copyStatus = document.getElementById('copy-email-status')
  document.querySelectorAll('[data-contact-open]').forEach(opener => opener.addEventListener('click', () => {
    copyStatus.textContent = ''
    if (!contact.open) contact.showModal()
  }))
  document.getElementById('copy-email').addEventListener('click', async () => {
    const email = document.getElementById('admin-email')
    try {
      await navigator.clipboard.writeText(email.value)
      copyStatus.textContent = '邮箱已复制。'
    } catch {
      email.select()
      copyStatus.textContent = '请选中邮箱复制，或在手机上长按复制。'
    }
  })
  const dialog = document.getElementById('install-dialog')
  const button = document.getElementById('install-app')
  const status = document.getElementById('install-status')
  const standalone = matchMedia('(display-mode: standalone)')
  let installPrompt = null
  const installed = () => standalone.matches || navigator.standalone === true
  function update() {
    button.hidden = installed() || !installPrompt
    status.textContent = installed() ? '当前已在应用窗口中运行，可以直接使用。'
      : installPrompt ? '当前浏览器支持安装，点击下方按钮继续。'
        : '若浏览器尚未显示安装按钮，请按下方对应系统的菜单方式安装。'
  }
  function open() {
    update()
    if (!dialog.open) dialog.showModal()
  }
  document.getElementById('open-install').addEventListener('click', event => { event.preventDefault(); open() })
  const url = new URL('/download', location.origin).href
  const address = document.getElementById('install-url')
  address.href = url
  address.textContent = url
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; update() })
  window.addEventListener('appinstalled', () => { installPrompt = null; update() })
  standalone.addEventListener('change', update)
  button.addEventListener('click', async () => {
    if (!installPrompt) return update()
    const prompt = installPrompt
    installPrompt = null
    try {
      await prompt.prompt()
      const { outcome } = await prompt.userChoice
      update()
      status.textContent = outcome === 'accepted' ? '已接受安装，请按浏览器提示完成。' : '已取消安装，可随时从浏览器菜单重新安装。'
    } catch {
      update()
      status.textContent = '未能打开安装窗口，请使用下方浏览器菜单方式安装。'
    }
  })
  function connection() {
    document.getElementById('connection-state').hidden = navigator.onLine
  }
  window.addEventListener('online', connection)
  window.addEventListener('offline', connection)
  connection()
  update()
  if (location.pathname === '/download') open()
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch(() => { status.textContent = '应用组件暂未就绪，请检查网络并刷新页面；也可继续使用网页版。' })
  }
})()
