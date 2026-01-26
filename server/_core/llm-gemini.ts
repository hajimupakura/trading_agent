/**
 * Gemini 2.0 Flash LLM integration via OpenRouter
 * Supports multimodal inputs (text, images, charts)
 */

import axios from "axios";

const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "google/gemini-2.0-flash-exp:free";

export interface Message {
  role: "system" | "user" | "assistant";
  content: string | Array<{
    type: "text" | "image_url";
    text?: string;
    image_url?: {
      url: string;
    };
  }>;
}

export interface LLMOptions {
  messages: Message[];
  temperature?: number;
  max_tokens?: number;
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, any>;
    };
  };
}

export interface LLMResponse {
  choices: Array<{
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Invoke Gemini 2.0 Flash via OpenRouter
 */
export async function invokeGemini(options: LLMOptions): Promise<LLMResponse> {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  try {
    const payload: Record<string, any> = {
      model: LLM_MODEL,
      messages: options.messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 4096,
    };

    // Add response format if specified (for structured JSON output)
    if (options.response_format) {
      payload.response_format = options.response_format;
    }

    const response = await axios.post(
      `${OPENROUTER_API_URL}/chat/completions`,
      payload,
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/yourusername/ai-trading-agent",
          "X-Title": "AI Trading Agent",
        },
        timeout: 60000, // 60 second timeout
      }
    );

    return response.data as LLMResponse;
  } catch (error: any) {
    console.error("Gemini LLM error:", error.response?.data || error.message);
    
    // Return a fallback response on error
    return {
      choices: [{
        message: {
          role: "assistant",
          content: JSON.stringify({
            error: "LLM request failed",
            message: error.message,
          }),
        },
        finish_reason: "error",
      }],
    };
  }
}

/**
 * Analyze trading chart image with Gemini
 * (Future feature - for when user uploads chart images)
 */
export async function analyzeChartImage(imageUrl: string, question: string): Promise<string> {
  const response = await invokeGemini({
    messages: [
      {
        role: "system",
        content: "You are a financial analyst expert in technical analysis. Analyze trading charts and provide insights on trends, support/resistance levels, and trading signals.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: question,
          },
          {
            type: "image_url",
            image_url: {
              url: imageUrl,
            },
          },
        ],
      },
    ],
    temperature: 0.5,
  });

  return response.choices[0]?.message?.content || "Unable to analyze chart";
}

/**
 * Export for backward compatibility with existing code
 */
export const invokeLLM = invokeGemini;
