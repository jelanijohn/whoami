// Setup instructions for every credential Who Am I asks the user to paste.
// Rendered by CredentialHelp.svelte: a help icon beside each token/key field
// opens a popup with these steps + required scopes + a link to the provider's
// docs (opened in the system browser).
//
// Keys match the live-source ids used on the Import page (github/asana/gmail —
// see LiveSource in src/lib/state.svelte.ts) plus `gmail-client` for the
// bring-your-own Google OAuth client fields and `anthropic` for the LLM API
// key field on the Data page. Scopes mirror what the ingest adapters actually
// require.

export type CredentialHelp = {
  title: string;
  steps: string[];
  scopes?: string[];
  note?: string;
  docsUrl?: string;
};

export const credentialHelp: Record<string, CredentialHelp> = {
  github: {
    title: 'GitHub personal access token',
    steps: [
      'Go to github.com → Settings → Developer settings → Personal access tokens.',
      'Create a token (Fine-grained or “Tokens (classic)”).',
      'Grant read access to the repositories you want Who Am I to see.',
      'Copy the token (starts with ghp_…) and paste it here.'
    ],
    scopes: ['repo (classic)', 'Contents: read-only (fine-grained)'],
    note: 'Only needed for private repositories — public repos work without a token.',
    docsUrl:
      'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens'
  },
  asana: {
    title: 'Asana personal access token',
    steps: [
      'Open Asana → your profile photo → Settings → Apps.',
      'Click “Manage developer apps”, then “Create new token” (Personal access tokens).',
      'Name it, agree to the terms, and copy the token.',
      'Paste it here.'
    ],
    note: 'A personal access token reads the tasks you have access to — Who Am I never writes.',
    docsUrl: 'https://developers.asana.com/docs/personal-access-token'
  },
  gmail: {
    title: 'Connect Gmail (read-only)',
    steps: [
      'Save your Google OAuth client (ID + secret) on this card first — one-time setup, see the help icon beside those fields.',
      'Click “Connect Gmail”. Your browser opens a Google sign-in page.',
      'Pick the account and approve read-only Gmail access.',
      'Return to Who Am I — the connection is stored in your OS keyring and access tokens refresh automatically from then on.'
    ],
    scopes: ['gmail.readonly'],
    note: 'Metadata-only — Who Am I reads subjects and snippets to build candidates, never full message bodies. Disconnect any time; revoking access in your Google account also invalidates the stored grant.',
    docsUrl: 'https://developers.google.com/gmail/api/auth/scopes'
  },
  'gmail-client': {
    title: 'Your Google OAuth client (one-time setup)',
    steps: [
      'Go to console.cloud.google.com and create (or pick) a project.',
      'APIs & Services → Library → enable the Gmail API.',
      'APIs & Services → OAuth consent screen: set it up and set the publishing status to “In production” (in “Testing”, Google revokes the connection after 7 days).',
      'APIs & Services → Credentials → Create credentials → OAuth client ID → application type “Desktop app”.',
      'Copy the client ID and client secret and paste them here.'
    ],
    note: 'Who Am I ships no shared Google credentials — you bring your own Desktop OAuth client. Both values live only in your OS keyring. Desktop clients auto-allow loopback redirect URIs, so there is nothing to register.',
    docsUrl: 'https://developers.google.com/identity/protocols/oauth2/native-app'
  },
  shortcut: {
    title: 'Shortcut API token',
    steps: [
      'Open app.shortcut.com → Settings → Your Account → API Tokens.',
      'Name a new token and click “Generate Token”.',
      'Copy the token and paste it here.'
    ],
    note: 'A Shortcut token grants complete account access, so it lives only in your OS keyring. Who Am I uses it read-only, to enrich GitHub imports that reference a ticket (sc-12345) with that story’s metadata.',
    docsUrl: 'https://developer.shortcut.com/api/rest/v3#Authentication'
  },
  anthropic: {
    title: 'Anthropic API key',
    steps: [
      'Go to console.anthropic.com and sign in.',
      'Open Settings → API keys.',
      'Click “Create Key”, name it, and copy the value (starts with sk-ant-).',
      'Paste it here.'
    ],
    note: 'Used only for the optional LLM triage and reduce passes — the key is stored in your OS keyring, never in the record.',
    docsUrl: 'https://console.anthropic.com/settings/keys'
  }
};
