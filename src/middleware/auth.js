const basicAuth = require('basic-auth');

/**
 * Middleware to protect the main dashboard via static URL token.
 * Accepts token via query parameter (?token=...), x-dashboard-token header,
 * or auth_token cookie.
 */
function tokenAuthMiddleware(req, res, next) {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'secret123';
  
  // Extract token from query, header, or cookie
  const queryToken = req.query.token;
  const headerToken = req.headers['x-dashboard-token'] || 
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') 
      ? req.headers.authorization.slice(7) 
      : null);
  
  // Parse cookie if present
  let cookieToken = null;
  if (req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match) {
      cookieToken = decodeURIComponent(match[1]);
    }
  }

  const token = queryToken || headerToken || cookieToken;

  if (token && token === expectedToken) {
    // If token came via query param, set cookie so subsequent asset fetches are authenticated
    if (queryToken) {
      res.cookie('auth_token', expectedToken, {
        path: '/',
        httpOnly: false, // accessible to client JS for socket.io token extraction
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      });
    }
    return next();
  }

  // If request expects HTML, send clean 401 page
  if (req.accepts('html')) {
    return res.status(401).send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <title>401 Unauthorized - Smart Home Dashboard</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; max-width: 420px; border: 1px solid #334155; }
          h1 { color: #f43f5e; margin-bottom: 0.5rem; font-size: 1.75rem; }
          p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; }
          code { background: #0f172a; color: #38bdf8; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.85rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>Access Denied</h1>
          <p>A valid static URL token is required to view this dashboard.</p>
          <p>Please access the dashboard using <code>?token=YOUR_TOKEN</code></p>
        </div>
      </body>
      </html>
    `);
  }

  return res.status(401).json({ error: 'Unauthorized', message: 'Valid token required' });
}

/**
 * Middleware to protect the admin panel (/admin) with HTTP Basic Authentication.
 */
function basicAuthMiddleware(req, res, next) {
  const user = basicAuth(req);
  const expectedUser = process.env.ADMIN_USERNAME || 'admin';
  const expectedPass = process.env.ADMIN_PASSWORD || 'adminpass';

  if (!user || user.name !== expectedUser || user.pass !== expectedPass) {
    res.set('WWW-Authenticate', 'Basic realm="Smart Home Admin Area"');
    return res.status(401).send('401 Unauthorized: Access to Admin Area requires valid credentials.');
  }

  next();
}

/**
 * Socket.IO authentication middleware.
 * Verifies token provided in auth handshake or query.
 */
function socketAuthMiddleware(socket, next) {
  const expectedToken = process.env.DASHBOARD_TOKEN || 'secret123';
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (token === expectedToken) {
    return next();
  }

  // Also allow connection if client is authenticated as admin or has matching cookie
  if (socket.handshake.headers.cookie) {
    const match = socket.handshake.headers.cookie.match(/(?:^|;\s*)auth_token=([^;]+)/);
    if (match && decodeURIComponent(match[1]) === expectedToken) {
      return next();
    }
  }

  const err = new Error('Unauthorized Socket.IO connection: invalid token');
  err.data = { status: 401 };
  next(err);
}

module.exports = {
  tokenAuthMiddleware,
  basicAuthMiddleware,
  socketAuthMiddleware
};
