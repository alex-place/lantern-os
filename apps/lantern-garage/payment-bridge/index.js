/*
 * ⚠️ RETIRED — DO NOT BOOT. NOT the canonical billing surface. (#2657)
 *
 * The live, guarded Stripe integration is `apps/lantern-garage/routes/billing.js`
 * (checkout / portal / signature-verified webhook, role-whitelisted, tier-enforced).
 * This standalone bridge predates both the $20 Pro tier and the Member-tier retirement
 * (#2613): its ladder sells only the retired `supporter` tier + `pilot` and cannot sell
 * Pro, and it bypasses routes/billing.js's guards and webhook role whitelisting. Nothing
 * imports or boots it. Kept only as a reference until formally deleted — do not wire real
 * price ids or a webhook to it.
 */
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Load configuration
const configPath = path.join(__dirname, 'config.example.json');
let config = {};
try {
  const configContent = fs.readFileSync(configPath, 'utf8');
  config = JSON.parse(configContent);
  
  // Override with environment variables if present
  if (process.env.STRIPE_SECRET_KEY) {
    config.paymentProviders.stripe.secretKey = process.env.STRIPE_SECRET_KEY;
  }
  if (process.env.STRIPE_PUBLISHABLE_KEY) {
    config.paymentProviders.stripe.publishableKey = process.env.STRIPE_PUBLISHABLE_KEY;
  }
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    config.paymentProviders.stripe.webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  }
  if (process.env.STRIPE_MODE) {
    config.paymentProviders.stripe.mode = process.env.STRIPE_MODE;
  }
  if (process.env.PAYMENT_BRIDGE_PORT) {
    config.server.port = parseInt(process.env.PAYMENT_BRIDGE_PORT);
  }
} catch (error) {
  console.error('Failed to load config:', error.message);
}

const app = express();
const PORT = config.server.port || 3000;

// Security middleware
app.use(helmet());
app.use(bodyParser.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: config.security.rateLimitWindowMs || 15 * 60 * 1000,
  max: config.security.rateLimitMaxRequests || 100,
  message: 'Too many requests from this IP'
});
app.use('/api/payment/', limiter);

// Import stripe only if configured
let stripe = null;
if (config.paymentProviders.stripe.enabled && config.paymentProviders.stripe.secretKey) {
  try {
    stripe = require('stripe')(config.paymentProviders.stripe.secretKey);
  } catch (error) {
    console.error('Failed to initialize Stripe:', error.message);
  }
}

// Import invoice converter
let invoiceConverter;
try {
  invoiceConverter = require('./stripe-invoice-converter');
} catch (error) {
  console.error('Failed to load invoice converter:', error.message);
}

// Helper functions
const repoRoot = path.resolve(__dirname, '../../..');
const walletPath = path.join(repoRoot, config.wallet.dataPath || 'data/wallet');
const ledgerPath = path.join(walletPath, config.wallet.ledgerFile || 'ledger.jsonl');
const walletStatePath = path.join(walletPath, config.wallet.walletStateFile || 'local-cash-wallet.json');

function readWalletState() {
  try {
    const content = fs.readFileSync(walletStatePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error('Failed to read wallet state:', error.message);
    return null;
  }
}

function writeWalletState(state) {
  try {
    fs.writeFileSync(walletStatePath, JSON.stringify(state, null, 2));
    return true;
  } catch (error) {
    console.error('Failed to write wallet state:', error.message);
    return false;
  }
}

function appendToLedger(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(ledgerPath, line);
    return true;
  } catch (error) {
    console.error('Failed to append to ledger:', error.message);
    return false;
  }
}

// API Routes

// Health check
app.get('/api/payment/health', (req, res) => {
  res.json({
    status: 'ok',
    stripe: stripe ? 'configured' : 'not configured',
    mode: config.paymentProviders.stripe.mode,
    timestamp: new Date().toISOString()
  });
});

// Get wallet status
app.get('/api/payment/wallet-status', (req, res) => {
  const walletState = readWalletState();
  if (!walletState) {
    return res.status(500).json({ error: 'Failed to read wallet state' });
  }
  
  res.json({
    clearedCash: walletState.clearedCashUsd || 0,
    pendingInvoices: walletState.pendingInvoices || [],
    existingOffers: walletState.existingOffersOnly || [],
    currency: walletState.currency || 'USD'
  });
});

// Create invoice from wallet
app.post('/api/payment/create-invoice', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  try {
    const { invoiceId } = req.body;
    
    // Get wallet state
    const walletState = readWalletState();
    if (!walletState) {
      return res.status(500).json({ error: 'Failed to read wallet state' });
    }
    
    // Find invoice
    const invoice = walletState.pendingInvoices.find(inv => inv.invoiceId === invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
    
    // Generate Stripe invoice
    const stripeInvoiceData = invoiceConverter.generateStripeInvoiceFromWallet(invoice);
    
    // Create Stripe customer first
    const customer = await stripe.customers.create({
      email: invoice.customerEmail || 'customer@example.com',
      metadata: {
        lantern_invoice_id: invoiceId
      }
    });
    
    // Create Stripe invoice
    const stripeInvoice = await stripe.invoices.create({
      customer: customer.id,
      description: stripeInvoiceData.description,
      currency: stripeInvoiceData.currency,
      due_date: stripeInvoiceData.due_date,
      metadata: stripeInvoiceData.metadata
    });
    
    // Add line item
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: stripeInvoiceData.items[0].amount,
      currency: stripeInvoiceData.items[0].currency,
      description: stripeInvoiceData.items[0].description,
      invoice: stripeInvoice.id
    });
    
    // Finalize invoice
    const finalizedInvoice = await stripe.invoices.finalizeInvoice(stripeInvoice.id);
    
    // Update ledger
    appendToLedger({
      event: 'stripe_invoice_created',
      invoiceId: invoiceId,
      stripeInvoiceId: finalizedInvoice.id,
      stripeInvoiceUrl: finalizedInvoice.hosted_url,
      timestamp: new Date().toISOString()
    });
    
    res.json({
      success: true,
      invoiceId: finalizedInvoice.id,
      invoiceUrl: finalizedInvoice.hosted_url,
      amount: finalizedInvoice.amount_due / 100,
      customer: customer.id
    });
    
  } catch (error) {
    console.error('Invoice creation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      type: error.type
    });
  }
});

// Webhook endpoint
app.post('/api/payment/webhook', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  const sig = req.headers['stripe-signature'];
  const webhookSecret = config.paymentProviders.stripe.webhookSecret;
  
  if (!webhookSecret) {
    console.warn('Webhook secret not configured, skipping signature verification');
  } else {
    try {
      const event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      await handleWebhookEvent(event);
      return res.json({ received: true });
    } catch (err) {
      console.log(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
  
  // If no webhook secret, still try to process the event
  try {
    const event = req.body;
    await handleWebhookEvent(event);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'invoice.payment_succeeded':
      await handlePaymentSuccess(event.data.object);
      break;
    case 'invoice.payment_failed':
      await handlePaymentFailure(event.data.object);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }
}

async function handlePaymentSuccess(invoice) {
  const lanternInvoiceId = invoice.metadata?.lantern_invoice_id;
  if (!lanternInvoiceId) {
    console.log('No lantern invoice ID in metadata');
    return;
  }
  
  // Update wallet state
  const walletState = readWalletState();
  if (walletState) {
    walletState.clearedCashUsd = (walletState.clearedCashUsd || 0) + (invoice.amount_paid / 100);
    
    // Remove from pending
    walletState.pendingInvoices = walletState.pendingInvoices.filter(
      inv => inv.invoiceId !== lanternInvoiceId
    );
    
    // Add to received payments
    walletState.receivedPayments = walletState.receivedPayments || [];
    walletState.receivedPayments.push({
      invoiceId: lanternInvoiceId,
      amount: invoice.amount_paid / 100,
      currency: invoice.currency,
      clearedAt: new Date().toISOString(),
      stripePaymentId: invoice.payment_intent
    });
    
    writeWalletState(walletState);
  }
  
  // Update ledger
  appendToLedger({
    event: 'payment_cleared',
    invoiceId: lanternInvoiceId,
    amount: invoice.amount_paid / 100,
    currency: invoice.currency,
    stripePaymentId: invoice.payment_intent,
    timestamp: new Date().toISOString()
  });
  
  console.log(`Payment succeeded for invoice ${lanternInvoiceId}: $${invoice.amount_paid / 100}`);
}

function updateDiscordSubscriber(invoice) {
  try {
    const tierId = invoice.metadata?.tierId;
    const customerEmail = invoice.customer_email;
    if (!tierId) return;
    const subPath = path.join(repoRoot, 'data', 'discord', 'subscribers.json');
    let subs = { subscribers: [] };
    if (fs.existsSync(subPath)) {
      try { subs = JSON.parse(fs.readFileSync(subPath, 'utf8')); } catch (e) { subs = { subscribers: [] }; }
    }
    subs.subscribers = subs.subscribers || [];
    subs.subscribers.push({
      stripeCustomerId: invoice.customer,
      stripeInvoiceId: invoice.id,
      tierId,
      email: customerEmail,
      amount: invoice.amount_paid / 100,
      currency: invoice.currency,
      status: 'active',
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(subPath, JSON.stringify(subs, null, 2));
    console.log([DISCORD] Subscriber record updated: );
  } catch (e) {
    console.error([DISCORD] Failed to update subscriber: );
  }
}

async function handlePaymentFailure(invoice) {
  const lanternInvoiceId = invoice.metadata?.lantern_invoice_id;
  if (!lanternInvoiceId) {
    return;
  }
  
  appendToLedger({
    event: 'payment_failed',
    invoiceId: lanternInvoiceId,
    stripePaymentId: invoice.payment_intent,
    error: invoice.last_payment_error?.message || 'Unknown error',
    timestamp: new Date().toISOString()
  });
  
  console.log(`Payment failed for invoice ${lanternInvoiceId}`);
}

// Create Stripe Checkout session
app.post('/api/payment/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  try {
    const { tierId, email } = req.body;
    const priceMap = config.paymentProviders?.stripe?.priceIds || {
      supporter: 'price_1QQQQQQQQQQQQQ',
      pilot: 'price_2QQQQQQQQQQQQQ'
    };
    const priceId = priceMap[tierId];
    if (!priceId) {
      return res.status(400).json({ error: 'Unknown tier' });
    }
    const session = await stripe.checkout.sessions.create({
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${req.headers.origin || 'http://127.0.0.1:4177'}/pricing.html?checkout=success`,
      cancel_url: `${req.headers.origin || 'http://127.0.0.1:4177'}/pricing.html?checkout=cancel`,
      customer_email: email || undefined,
      metadata: { tierId, lantern_os: 'true' }
    });
    res.json({ url: session.url });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Lantern Payment Bridge running on port ${PORT}`);
  console.log(`Stripe ${config.paymentProviders.stripe.enabled ? 'enabled' : 'disabled'} in ${config.paymentProviders.stripe.mode} mode`);
  console.log(`Wallet data path: ${walletPath}`);
});