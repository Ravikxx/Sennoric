export const OAUTH_PROVIDERS = {
  github: {
    label:        'GitHub',
    clientId:     process.env.SENNORIC_GITHUB_CLIENT_ID     || '',
    clientSecret: process.env.SENNORIC_GITHUB_CLIENT_SECRET || '',
    // Redirect flow ("click Connect, approve on github.com, done") — the
    // same UX as Google. GitHub requires an exact redirect_uri match against
    // the app's registered callback URL, so this pins a fixed local port
    // rather than picking a random free one (see redirectFlow in oauth.js).
    tokenFlow:     'redirect',
    authURL:       'https://github.com/login/oauth/authorize',
    tokenURL:      'https://github.com/login/oauth/access_token',
    redirectPort:  53219,
    deviceCodeURL: 'https://github.com/login/device/code',
    verifyURL:     'https://github.com/login/device',
    scopes:        'repo read:org read:user',
    mcpServer:     '@modelcontextprotocol/server-github',
    mcpEnv:        (token) => ({ GITHUB_TOKEN: token }),
    mcpCommand:    'npx',
    mcpArgs:       ['-y', '@modelcontextprotocol/server-github'],
  },
  google: {
    label:        'Google',
    clientId:     process.env.SENNORIC_GOOGLE_CLIENT_ID     || '',
    clientSecret: process.env.SENNORIC_GOOGLE_CLIENT_SECRET || '',
    tokenFlow:    'redirect',
    authURL:      'https://accounts.google.com/o/oauth2/v2/auth',
    tokenURL:     'https://oauth2.googleapis.com/token',
    scopes:       'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events openid email profile',
    mcpServer:    null,
  },
  notion: {
    label:         'Notion',
    clientId:      process.env.SENNORIC_NOTION_CLIENT_ID     || '',
    clientSecret:  process.env.SENNORIC_NOTION_CLIENT_SECRET || '',
    // Redirect flow — same "click Connect, approve on notion.so, done" UX as
    // Google/GitHub, via a public integration instead of pasting an internal
    // integration's token. Notion requires an exact redirect_uri match (pin
    // a fixed port, like GitHub), authorizes the token exchange with HTTP
    // Basic auth rather than a client_secret in the body, doesn't document
    // PKCE support (so it's disabled here), and requires an "owner=user"
    // param with no equivalent "scope" concept — Notion's connections grant
    // capabilities chosen by the user during the authorize step instead.
    tokenFlow:      'redirect',
    authURL:        'https://api.notion.com/v1/oauth/authorize',
    tokenURL:       'https://api.notion.com/v1/oauth/token',
    redirectPort:   53229,
    tokenAuthStyle: 'basic',
    pkce:           false,
    extraAuthParams: { owner: 'user' },
    hint:       'Go to notion.so/my-integrations → New integration → copy the Internal Integration Token',
    mcpServer:  '@notionhq/notion-mcp-server',
    mcpEnv:     (token) => ({ NOTION_TOKEN: token }),
    mcpCommand: 'npx',
    mcpArgs:    ['-y', '@notionhq/notion-mcp-server'],
  },
  slack: {
    label:      'Slack',
    tokenFlow:  'paste',
    hint:       'Go to api.slack.com/apps → create app → OAuth & Permissions → copy Bot User OAuth Token',
    mcpServer:  '@modelcontextprotocol/server-slack',
    mcpEnv:     (token) => ({ SLACK_BOT_TOKEN: token }),
    mcpCommand: 'npx',
    mcpArgs:    ['-y', '@modelcontextprotocol/server-slack'],
  },
};
