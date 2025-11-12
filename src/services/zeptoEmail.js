const ZEPTO_URL = 'https://api.zeptomail.com/v1.1/email';

const SENDERS = {
  NO_REPLY: { address: 'noreply@housika.co.ke', name: 'Housika No Reply' },
  BOOKINGS: { address: 'bookings@housika.co.ke', name: 'Housika Bookings' },
  CUSTOMER_CARE: { address: 'customercare@housika.co.ke', name: 'Housika Customer Care' },
};

export class ZeptoMailError extends Error {
  constructor(message, data = null) {
    super(message);
    this.name = 'ZeptoMailError';
    this.data = data;
  }
}

let zeptoApiKey, setupError, setupPromise;

const ensureReady = async (env) => {
  if (setupError) throw setupError;
  if (zeptoApiKey) return;

  if (!setupPromise) {
    setupPromise = (async () => {
      zeptoApiKey = env?.ZEPTO_API_KEY || process.env.ZEPTO_API_KEY;
      if (!zeptoApiKey?.startsWith('Zoho-')) {
        setupError = new ZeptoMailError('ZeptoMail API key missing or malformed.');
      }
    })();
  }

  await setupPromise;
  if (setupError) throw setupError;
};

export async function initZeptoMail(env) {
  await ensureReady(env);

  const formatRecipients = (to, name = 'User') => {
    const list = Array.isArray(to) ? to : [to];
    return list.map(email => {
      if (typeof email !== 'string' || !email.includes('@')) {
        throw new ZeptoMailError(`Invalid recipient: ${email}`);
      }
      return { email_address: { address: email, name } };
    });
  };

  const sendEmail = async ({ sender, to, subject, htmlbody, recipientName = 'User' }) => {
    if (!sender?.address || !sender?.name || !to || !subject || !htmlbody) {
      throw new ZeptoMailError('Missing required email fields.');
    }

    const payload = {
      from: sender,
      to: formatRecipients(to, recipientName),
      subject,
      htmlbody,
    };

    try {
      const res = await fetch(ZEPTO_URL, {
        method: 'POST',
        headers: {
          Authorization: zeptoApiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ZeptoMailError(data.message || 'Email failed', data);
      return data;
    } catch (err) {
      const detail = err instanceof ZeptoMailError ? err.data : err.stack || err;
      console.error(`[ZEPTOMAIL ERROR] ${sender.address} → ${to}`, detail);
      throw err instanceof ZeptoMailError ? err : new ZeptoMailError('Unexpected email error.', detail);
    }
  };

  return {
    sendVerificationEmail: (p) => sendEmail({ sender: SENDERS.NO_REPLY, ...p }),
    sendPasswordReset: (p) => sendEmail({ sender: SENDERS.NO_REPLY, ...p }),
    sendBookingConfirmation: (p) => sendEmail({ sender: SENDERS.BOOKINGS, ...p }),
    sendCustomerCareReply: (p) => sendEmail({ sender: SENDERS.CUSTOMER_CARE, ...p }),
  };
}
