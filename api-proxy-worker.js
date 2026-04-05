// ═══════════════════════════════════════════════════════════════════
// CLOUDFLARE WORKER - API Proxy for Shazam Crypto
// Deploy this to Cloudflare Workers and update your domain routing
// ═══════════════════════════════════════════════════════════════════

// Your Anthropic API key (set as environment variable in Cloudflare)
// Go to: Workers > Your Worker > Settings > Variables > Add ANTHROPIC_API_KEY

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      const { image, prompt } = body;

      // Build the messages array
      const messages = [{
        role: 'user',
        content: []
      }];

      // Add image if provided
      if (image) {
        messages[0].content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: image
          }
        });
      }

      // Add the text prompt
      messages[0].content.push({
        type: 'text',
        text: prompt
      });

      // Call Anthropic API
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: messages
        })
      });

      const data = await response.json();

      // Return the response with CORS headers
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });

    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
