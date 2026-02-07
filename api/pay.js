const { Client, Environment } = require('square');
const crypto = require('crypto');

// Use environment variables for secrets
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const LOCATION_ID = process.env.SQUARE_LOCATION_ID;
const CATALOG_ITEM_ID = process.env.SQUARE_CATALOG_ITEM_ID;

const client = new Client({
    accessToken: SQUARE_ACCESS_TOKEN,
    environment: Environment.Production,
});

// Get or create customer by name
async function getOrCreateCustomer(customerName) {
    try {
        const searchResponse = await client.customersApi.searchCustomers({
            query: {
                filter: {
                    referenceId: {
                        exact: customerName.toLowerCase().replace(/\s+/g, '_')
                    }
                }
            }
        });

        if (searchResponse.result.customers && searchResponse.result.customers.length > 0) {
            return searchResponse.result.customers[0].id;
        }

        const nameParts = customerName.trim().split(' ');
        const createResponse = await client.customersApi.createCustomer({
            givenName: nameParts[0] || customerName,
            familyName: nameParts.slice(1).join(' ') || '',
            referenceId: customerName.toLowerCase().replace(/\s+/g, '_'),
            idempotencyKey: crypto.randomUUID()
        });

        return createResponse.result.customer.id;
    } catch (error) {
        console.error('Customer error:', error.errors?.[0]?.detail || error.message);
        return null;
    }
}

// Get item variation ID
async function getItemVariationId() {
    try {
        const response = await client.catalogApi.retrieveCatalogObject(CATALOG_ITEM_ID, true);
        const item = response.result.object;
        if (item?.itemData?.variations?.length > 0) {
            return item.itemData.variations[0].id;
        }
    } catch (error) {
        console.error('Catalog error:', error.errors?.[0]?.detail || error.message);
    }
    return null;
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { sourceId, amount, customerName, pickupDate, items } = req.body;
    
    const itemVariationId = await getItemVariationId();
    if (!itemVariationId) {
        return res.status(500).json({ success: false, error: 'Item variation not configured' });
    }
    
    try {
        const customerId = await getOrCreateCustomer(customerName);
        
        // Create Order
        const orderResponse = await client.ordersApi.createOrder({
            order: {
                locationId: LOCATION_ID,
                customerId: customerId,
                lineItems: items.map(item => ({
                    quantity: String(item.quantity),
                    catalogObjectId: itemVariationId,
                    basePriceMoney: {
                        amount: BigInt(Math.round(item.price * 100)),
                        currency: 'USD'
                    },
                    note: item.name + (item.comment ? ` - ${item.comment}` : '')
                })),
                state: 'OPEN'
            },
            idempotencyKey: crypto.randomUUID()
        });

        const order = orderResponse.result.order;

        // Process Payment
        const paymentResponse = await client.paymentsApi.createPayment({
            sourceId: sourceId,
            idempotencyKey: crypto.randomUUID(),
            amountMoney: {
                amount: BigInt(Math.round(amount * 100)),
                currency: 'USD',
            },
            locationId: LOCATION_ID,
            orderId: order.id,
            customerId: customerId,
            note: `Pickup: ${pickupDate}`,
        });
        
        res.json({ 
            success: true, 
            paymentId: paymentResponse.result.payment.id,
            orderId: order.id,
            status: paymentResponse.result.payment.status 
        });
    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.errors?.[0]?.detail || error.message 
        });
    }
};
