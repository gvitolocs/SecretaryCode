const $ = id => document.getElementById(id)
const bridge = window.electron?.codingLanes
let polling = false
let output = ''
const hints = {
  claude: 'Runs your installed Claude CLI with its current account and permission settings.',
  zcode: 'Runs the ZCode CLI on nezopt. An expired Z.AI login must be renewed in ZCode before tasks can run.',
  qwen: 'Checks the shared Qwen slot before dispatch. Busy or unknown availability blocks launch; the existing worker lock remains the final arbiter.',
  orchestra: 'Uses the existing Orchestra controller with the selected OpenCode worker strictly pinned. Provider quota limits are reported without switching workers.',
}
function showError(message) { $('error').textContent = message; $('error').hidden = !message }
async function request(action, input) {
  if (!bridge) throw new Error('Coding-agent bridge is unavailable. Rebuild and reopen Secretary Code.')
  const result = await bridge.request(action, input)
  if (!result.ok) throw new Error(result.error || 'Request failed')
  return result.data
}
function laneChanged() {
  $('remote-field').hidden = $('lane').value === 'claude'
  $('worker-field').hidden = $('lane').value !== 'orchestra'
  $('lane-hint').textContent = hints[$('lane').value]
}
function render(data) {
  $('status').textContent = data.status
  $('run').disabled = data.running
  $('cancel').disabled = !data.running
  for (const id of ['project', 'pick', 'lane', 'worker', 'remote', 'prompt']) $(id).disabled = data.running
  if (data.output !== output) {
    const nearBottom = $('output').scrollTop + $('output').clientHeight >= $('output').scrollHeight - 30
    output = data.output
    $('output').textContent = output || 'Waiting for the agent…'
    if (nearBottom) $('output').scrollTop = $('output').scrollHeight
  }
}
async function poll() {
  if (polling) return
  polling = true
  try { render(await request('status')) } catch (error) { showError(error.message) } finally { polling = false }
}
$('lane').addEventListener('change', laneChanged)
$('pick').addEventListener('click', async () => { try { const result = await request('pick'); if (result.path) $('project').value = result.path } catch (error) { showError(error.message) } })
$('run').addEventListener('click', async () => {
  showError('')
  $('run').disabled = true
  try { await request('launch', { project: $('project').value, remoteProject: $('remote').value, lane: $('lane').value, worker: $('worker').value, prompt: $('prompt').value }); await poll() }
  catch (error) { showError(error.message); $('run').disabled = false }
})
$('cancel').addEventListener('click', async () => { try { await request('cancel'); await poll() } catch (error) { showError(error.message) } })
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(output); $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy output', 1200) } catch { showError('Select the output and press ⌘C to copy.') } })
laneChanged()
void poll()
setInterval(poll, 700)
