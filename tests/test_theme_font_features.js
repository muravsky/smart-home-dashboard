const assert = require('assert');
const http = require('http');
const ioClient = require('socket.io-client');
const { app, server } = require('../src/server');
const { 
  db, 
  getPageConfigs, 
  savePageConfig, 
  insertProfile, 
  getProfiles, 
  updateProfile,
  saveWidgetLayouts,
  getWidgetLayouts
} = require('../src/db');

const PORT = 3946;
const ADMIN_AUTH = 'Basic ' + Buffer.from('admin:your_admin_pass').toString('base64');

function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null, raw: data });
        } catch(e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

server.listen(PORT, async () => {
  console.log(`Theme & Font Size Features Test running on port ${PORT}\n`);

  try {
    // =========================================================================
    // 1. Profile Theme & Font Size Persistence
    // =========================================================================
    console.log('--- 1. Profile Theme & Font Size (CRUD) ---');
    
    // Create profile with white theme and large font
    const createRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/profiles',
      method: 'POST',
      headers: {
        'Authorization': ADMIN_AUTH,
        'Content-Type': 'application/json'
      }
    }, {
      name: 'ThemeTester',
      color: '#ec4899',
      avatar_type: 'builtin',
      avatar_value: '🎨',
      telegram_id: '99887766',
      theme: 'white',
      font_size: 'large'
    });

    assert.ok(createRes.status === 200 || createRes.status === 201, 'Should create profile with 200 or 201');
    const createdProfile = createRes.body.profile || createRes.body;
    assert.strictEqual(createdProfile.theme, 'white', 'Profile theme should be white');
    assert.strictEqual(createdProfile.font_size, 'large', 'Profile font_size should be large');
    console.log('[PASS] Created profile with theme="white" and font_size="large"');

    // Update profile to dark theme and xlarge font
    const updateRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/profiles/${createdProfile.id}`,
      method: 'PATCH',
      headers: {
        'Authorization': ADMIN_AUTH,
        'Content-Type': 'application/json'
      }
    }, {
      name: 'ThemeTesterUpdated',
      color: '#ec4899',
      avatar_type: 'builtin',
      avatar_value: '🎨',
      telegram_id: '99887766',
      theme: 'dark',
      font_size: 'xlarge'
    });

    assert.strictEqual(updateRes.status, 200, 'Should update profile with 200');
    const updatedProfile = updateRes.body.profile || updateRes.body;
    assert.strictEqual(updatedProfile.theme, 'dark', 'Updated theme should be dark');
    assert.strictEqual(updatedProfile.font_size, 'xlarge', 'Updated font_size should be xlarge');
    console.log('[PASS] Updated profile to theme="dark" and font_size="xlarge"');

    // =========================================================================
    // 2. Page Configs REST API (Theme & Font Size per page / profile)
    // =========================================================================
    console.log('\n--- 2. Page Configs REST API ---');

    // Save page config for page 0 of family profile
    const savePageRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/admin/page-config',
      method: 'POST',
      headers: {
        'Authorization': ADMIN_AUTH,
        'Content-Type': 'application/json'
      }
    }, {
      profile_key: 'family',
      page: 0,
      theme: 'white',
      font_size: 'small'
    });

    assert.strictEqual(savePageRes.status, 200, 'Save page config should return 200');
    console.log('[PASS] POST /api/admin/page-config saved page 0 config');

    // Fetch page configs
    const getPageRes = await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: '/api/page-configs',
      method: 'GET'
    });

    assert.strictEqual(getPageRes.status, 200, 'GET /api/page-configs should return 200');
    assert.ok(getPageRes.body['family_0'], 'page_configs should contain family_0');
    assert.strictEqual(getPageRes.body['family_0'].theme, 'white', 'family_0 theme should be white');
    assert.strictEqual(getPageRes.body['family_0'].font_size, 'small', 'family_0 font_size should be small');
    console.log('[PASS] GET /api/page-configs correctly returned page configuration');

    // =========================================================================
    // 3. Socket.IO Real-time Page Config and Widget Font Size
    // =========================================================================
    console.log('\n--- 3. Socket.IO Real-time Page Config & Widget Layout ---');

    const socket = ioClient(`http://localhost:${PORT}?token=your_secret_token`, {
      transports: ['websocket']
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket timeout')), 4000);

      socket.on('connect', () => {
        // Emit page:config:save for a dedicated profile page
        socket.emit('page:config:save', {
          profile_key: String(createdProfile.id),
          page: 1,
          theme: 'white',
          font_size: 'xlarge'
        });
      });

      socket.on('dashboard_update', (data) => {
        if (data && data.page_configs && data.page_configs[`${createdProfile.id}_1`]) {
          const cfg = data.page_configs[`${createdProfile.id}_1`];
          if (cfg.theme === 'white' && cfg.font_size === 'xlarge') {
            clearTimeout(timeout);
            console.log('[PASS] Socket received real-time broadcast of page:config:save update');
            resolve();
          }
        }
      });
    });

    // Test Widget-Level font_size in layout config
    const testLayouts = [
      {
        widget_type: 'clock',
        page: 0,
        x: 0,
        y: 0,
        w: 12,
        h: 2,
        config: { font_size: 'large' },
        position: 0
      },
      {
        widget_type: 'weather',
        page: 0,
        x: 0,
        y: 2,
        w: 6,
        h: 2,
        config: { font_size: 'small' },
        position: 1
      }
    ];

    saveWidgetLayouts(testLayouts, createdProfile.id);
    const loadedLayouts = getWidgetLayouts(createdProfile.id);
    assert.strictEqual(loadedLayouts.length, 2, 'Should have 2 layouts');
    assert.strictEqual(loadedLayouts[0].config.font_size, 'large', 'Clock widget font_size should be large');
    assert.strictEqual(loadedLayouts[1].config.font_size, 'small', 'Weather widget font_size should be small');
    console.log('[PASS] Widget layouts preserve widget-level font_size in config JSON');

    // Cleanup profile
    await makeRequest({
      hostname: 'localhost',
      port: PORT,
      path: `/api/admin/profiles/${createdProfile.id}`,
      method: 'DELETE',
      headers: { 'Authorization': ADMIN_AUTH }
    });

    socket.disconnect();
    server.close();
    console.log('\n=== ALL THEME & FONT SIZE TESTS PASSED SUCCESSFULLY ===\n');
    process.exit(0);

  } catch(err) {
    console.error('[FAIL] Test error:', err);
    process.exit(1);
  }
});
