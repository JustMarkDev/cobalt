const BRAND = '#2e5bff'
const ASSETS = 'https://cobaltforge.dev'

export type MailContent = {
  heading: string
  intro: string
  action: { label: string; url: string }
  outro?: string
}

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export function renderMail(m: MailContent): { text: string; html: string } {
  const text = [
    m.heading,
    '',
    m.intro,
    '',
    `${m.action.label}: ${m.action.url}`,
    ...(m.outro ? ['', m.outro] : []),
    '',
    '— cobalt',
  ].join('\n')

  const url = escape(m.action.url)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escape(m.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f8;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escape(m.intro)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
    <tr><td style="padding:0 4px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="${ASSETS}/favicon.png" width="28" height="28" alt="" style="display:block;border:0;"></td>
        <td style="vertical-align:middle;padding-left:8px;font:600 17px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b0d14;letter-spacing:-0.01em;">cobalt</td>
      </tr></table>
    </td></tr>
    <tr><td style="background:#ffffff;border:1px solid #e4e6ee;border-radius:16px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0b0d14;">
      <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-0.01em;">${escape(m.heading)}</h1>
      <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#454a5c;">${escape(m.intro)}</p>
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${BRAND};">
        <a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escape(m.action.label)}</a>
      </td></tr></table>
      <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7086;">If the button does not work, paste this link into your browser:<br><a href="${url}" style="color:${BRAND};word-break:break-all;">${url}</a></p>
      ${m.outro ? `<p style="margin:20px 0 0;padding-top:20px;border-top:1px solid #eceef4;font-size:13px;line-height:1.6;color:#6b7086;">${escape(m.outro)}</p>` : ''}
    </td></tr>
    <tr><td style="padding:20px 4px 0;font:12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#8a8fa3;">
      cobalt · <a href="${ASSETS}" style="color:#8a8fa3;">cobaltforge.dev</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`
  return { text, html }
}
