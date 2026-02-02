export const config = {
  runtime: 'edge',
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export default async function handler(req: Request) {
  try {
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: "Method not allowed" }), { 
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    let body;
    try {
        body = await req.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
    }

    const { contents, model, tools, tool_config, key, stream, system_instruction } = body;
    
    // Default model
    const modelName = model || "gemini-1.5-flash";

    // 1. Determine API Key
    let apiKey = key;
    if (!apiKey) {
        // Fallback to ENV
        const keysRaw = process.env.GEMINI_API_KEYS;
        if (keysRaw) {
            const keys = keysRaw.split(",").map(k => k.trim()).filter(Boolean);
            if (keys.length > 0) {
                apiKey = keys[Math.floor(Math.random() * keys.length)];
            }
        }
    }

    if (!apiKey) {
        return new Response(JSON.stringify({ error: "Server Configuration Error: No valid Gemini keys found." }), { 
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }

    // 2. Construct Payload
    const payload: any = {
      contents,
      generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192
      }
    };
    
    if (system_instruction) payload.systemInstruction = system_instruction;
    if (tools) payload.tools = tools;
    if (tool_config) payload.toolConfig = tool_config;

    // 3. Call Gemini API
    const method = stream ? "streamGenerateContent" : "generateContent";
    const url = `${GEMINI_API_BASE}/${modelName}:${method}?key=${apiKey}`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!geminiRes.ok) {
        const errorText = await geminiRes.text();
        return new Response(JSON.stringify({ error: "Gemini API Error", detail: errorText }), { 
            status: geminiRes.status,
            headers: { "Content-Type": "application/json" }
        });
    }

    // Forward Response
    if (stream) {
         // Gemini Stream returns a stream of JSON chunks
         // We might want to pass it through directly or parse it
         // Passing directly allows the client to handle the SSE parsing
         return new Response(geminiRes.body, {
            status: 200,
            headers: { 
                "Content-Type": "application/json", // Gemini stream is JSON array elements
                "Transfer-Encoding": "chunked"
            }
        });
    }

    const data = await geminiRes.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Server Internal Error", detail: err.message }), { 
        status: 500,
        headers: { "Content-Type": "application/json" }
    });
  }
}
