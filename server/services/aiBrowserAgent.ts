/**
 * Custom AI Browser Agent using Puppeteer + Gemini 2.0 Flash
 * Prompt-driven web automation that runs entirely on your server
 */

import puppeteer, { Browser, Page } from "puppeteer";
import { invokeLLM } from "../_core/llm";

let browser: Browser | null = null;

/**
 * Get or create browser instance
 */
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    });
  }
  return browser;
}

/**
 * Close browser
 */
export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Execute AI-driven browser task
 */
export async function executeAIBrowserTask(
  task: string,
  options: {
    maxSteps?: number;
    timeout?: number;
    returnScreenshot?: boolean;
  } = {}
): Promise<{
  success: boolean;
  data: any;
  steps: string[];
  screenshot?: string;
  error?: string;
}> {
  const { maxSteps = 10, timeout = 120000, returnScreenshot = false } = options;
  
  const steps: string[] = [];
  let currentStep = 0;
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    // Set timeout
    page.setDefaultTimeout(timeout);
    
    steps.push(`Starting task: ${task}`);
    
    // Main agent loop
    while (currentStep < maxSteps) {
      currentStep++;
      
      try {
        // Get current page state
        const pageState = await getPageState(page);
        
        // Ask Gemini what to do next
        const action = await decideNextAction(task, pageState, steps);
        
        if (action.type === "complete") {
          steps.push("Task completed");
          
          // Validate that we actually have data
          if (action.data === null || action.data === undefined) {
            console.warn("[AI Browser Agent] Task marked complete but data is null/undefined");
            steps.push("WARNING: Task completed but no data extracted");
          }
          
          const screenshot = returnScreenshot ? await page.screenshot({ encoding: "base64" }) : undefined;
          await page.close();
          
          return {
            success: true,
            data: action.data,
            steps,
            screenshot: screenshot as string | undefined,
          };
        }
        
        // Execute the action
        const actionResult = await executeAction(page, action);
        steps.push(`Step ${currentStep}: ${action.description} - ${actionResult}`);
        
        // Wait a bit between actions
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (actionError: any) {
        console.error(`[AI Browser Agent] Error in step ${currentStep}:`, actionError);
        steps.push(`ERROR in step ${currentStep}: ${actionError.message}`);
        
        // If it's an LLM error, fail immediately rather than continuing
        if (actionError.message?.includes("Failed to get valid action from LLM")) {
          await page.close();
          return {
            success: false,
            data: null,
            steps,
            error: `LLM error: ${actionError.message}`,
          };
        }
        
        // For other errors, continue but log them
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Max steps reached
    steps.push("Max steps reached, returning current data");
    const pageContent = await page.content();
    const screenshot = returnScreenshot ? await page.screenshot({ encoding: "base64" }) : undefined;
    await page.close();
    
    return {
      success: true,
      data: { html: pageContent },
      steps,
      screenshot: screenshot as string | undefined,
    };
    
  } catch (error: any) {
    console.error("AI Browser Agent error:", error);
    return {
      success: false,
      data: null,
      steps,
      error: error.message,
    };
  }
}

/**
 * Get current page state for Gemini
 */
async function getPageState(page: Page): Promise<string> {
  const url = page.url();
  const title = await page.title();
  
  // Get simplified DOM structure
  const dom = await page.evaluate(() => {
    const getSimplifiedDOM = (element: Element, depth: number = 0): string => {
      if (depth > 3) return "";

      // Skip elements without tagName (text nodes, etc)
      if (!element || !element.tagName) return "";

      let result = "";
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const classes = (element as HTMLElement).className ? `.${(element as HTMLElement).className.split(" ").join(".")}` : "";
      const text = element.textContent?.trim().substring(0, 50) || "";

      result += `${"  ".repeat(depth)}<${tag}${id}${classes}>${text ? ` "${text}"` : ""}\n`;

      for (const child of Array.from(element.children).slice(0, 5)) {
        result += getSimplifiedDOM(child, depth + 1);
      }

      return result;
    };
    
    return getSimplifiedDOM(document.body);
  });
  
  return `URL: ${url}\nTitle: ${title}\n\nDOM Structure:\n${dom.substring(0, 2000)}`;
}

/**
 * Ask Gemini to decide next action
 */
async function decideNextAction(
  task: string,
  pageState: string,
  previousSteps: string[]
): Promise<{
  type: "navigate" | "click" | "type" | "extract" | "complete";
  description: string;
  data?: any;
  target?: string;
  text?: string;
}> {
  const prompt = `You are an AI browser automation agent. Your task is: "${task}"

Previous steps taken:
${previousSteps.join("\n")}

Current page state:
${pageState}

Based on the task and current page state, decide the next action. You MUST respond with valid JSON only, no markdown, no code blocks, just the JSON object.

Action types:
- navigate: Go to a URL (provide "target" with the URL)
- click: Click an element (provide "target" with CSS selector)
- type: Type text into an input (provide "target" with CSS selector and "text" with the text to type)
- extract: Extract data from current page (no additional fields needed)
- complete: Task is finished (provide "data" with the final extracted data as JSON object or array)

Example for navigate:
{"type": "navigate", "description": "Navigate to Yahoo Finance", "target": "https://finance.yahoo.com"}

Example for complete with stock price data:
{"type": "complete", "description": "Extracted stock price", "data": {"price": 150.25, "change": 2.5, "changePercent": 1.69}}`;

  let response: any = null;
  try {
    response = await invokeLLM({
      messages: [
        {
          role: "system",
          content: "You are a browser automation agent. You MUST respond with ONLY valid JSON, no markdown formatting, no code blocks, no explanations. Just the raw JSON object.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: {
        type: "json_object"
      },
      output_schema: {
        name: "browser_action",
        schema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["navigate", "click", "type", "extract", "complete"],
              description: "The type of action to perform"
            },
            description: {
              type: "string",
              description: "Brief description of what you're doing"
            },
            target: {
              type: "string",
              description: "URL or CSS selector (required for navigate, click, type)"
            },
            text: {
              type: "string",
              description: "Text to type (required for type action)"
            },
            data: {
              type: ["object", "array", "string", "number"],
              description: "Extracted data (required for complete action)"
            }
          },
          required: ["type", "description"]
        }
      }
    });

    const messageContent = response.choices[0]?.message?.content || "{}";
    // Handle both string and array content formats
    let content = typeof messageContent === "string"
      ? messageContent
      : messageContent.map((c: any) => c.type === "text" ? c.text : "").join("");
    
    // Remove markdown code blocks if present
    content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let parsed = JSON.parse(content);

    // If LLM returns an array, take the first element
    if (Array.isArray(parsed) && parsed.length > 0) {
      parsed = parsed[0];
    }

    // Validate required fields
    if (!parsed.type || !parsed.description) {
      console.error("[AI Browser Agent] Invalid action response - missing type or description:", parsed);
      throw new Error("Invalid action format");
    }
    
    return parsed;
  } catch (error: any) {
    console.error("[AI Browser Agent] Error parsing LLM response:", error);
    if (response) {
      console.error("[AI Browser Agent] Raw response:", response.choices[0]?.message?.content);
    } else {
      console.error("[AI Browser Agent] No response received from LLM");
    }
    
    // Don't silently fail - throw error so caller knows something went wrong
    throw new Error(`Failed to get valid action from LLM: ${error.message}`);
  }
}

/**
 * Execute an action on the page
 */
async function executeAction(page: Page, action: any): Promise<string> {
  try {
    switch (action.type) {
      case "navigate":
        await page.goto(action.target, { waitUntil: "networkidle2" });
        return `Navigated to ${action.target}`;
        
      case "click":
        await page.click(action.target);
        return `Clicked ${action.target}`;
        
      case "type":
        await page.type(action.target, action.text);
        return `Typed into ${action.target}`;
        
      case "extract":
        const extracted = await page.evaluate(() => document.body.innerText);
        return `Extracted ${extracted.length} characters`;
        
      default:
        return "Unknown action type";
    }
  } catch (error: any) {
    return `Error: ${error.message}`;
  }
}

/**
 * Simplified scraping functions using AI agent
 */

export async function scrapeFinancialNews(topics: string[] = []): Promise<any[]> {
  const topicsStr = topics.length > 0 ? topics.join(", ") : "AI stocks, quantum computing, rare earth metals";

  const task = `You are a financial news scraper. Your goal is to find recent news articles about: ${topicsStr}

Step-by-step instructions:
1. Navigate to Yahoo Finance: https://finance.yahoo.com/topic/stock-market-news/
2. Wait for the page to load
3. Look for article headlines, links, and summaries on the page
4. For EACH article you find (get at least 5-10 articles):
   - Extract the article title/headline
   - Extract the article URL (full link)
   - Extract any visible summary or description
   - Extract the publication date (e.g., "2 hours ago", "Jan 27")
   - Note the source as "Yahoo Finance"

CRITICAL: Every article MUST have:
- title: non-empty headline text
- url: complete URL starting with https://
- summary: at least a brief description (use first paragraph if no summary)
- source: "Yahoo Finance"
- date: publication date string

Return a JSON array with this exact structure:
[
  {
    "title": "Article headline here",
    "summary": "Brief description of the article",
    "url": "https://finance.yahoo.com/news/...",
    "source": "Yahoo Finance",
    "date": "2 hours ago"
  }
]

If you cannot extract all required fields for an article, skip it. Only return articles with complete data.`;

  console.log(`[News Scraper] Starting scrape for topics: ${topicsStr}`);
  const result = await executeAIBrowserTask(task, { maxSteps: 15 });
  
  if (!result.success) {
    console.error(`[News Scraper] Failed: ${result.error}`);
    return [];
  }
  
  if (!result.data || result.data === null) {
    console.warn(`[News Scraper] Success but no data returned. Steps:`, result.steps);
    return [];
  }
  
  try {
    const articles = Array.isArray(result.data) ? result.data : [result.data];
    console.log(`[News Scraper] Successfully extracted ${articles.length} articles`);
    return articles;
  } catch (error) {
    console.error(`[News Scraper] Error processing data:`, error);
    return [];
  }
}

export async function scrapeARKTrades(): Promise<any[]> {
  const task = `Go to ark-funds.com and find the latest daily trade data for all ARK ETFs. 

For each trade, extract:
- fundName: name of the ARK fund (e.g., "ARK Innovation ETF")
- ticker: fund ticker symbol (e.g., "ARKK")
- company: company stock being traded
- direction: "buy" or "sell"
- shares: number of shares traded
- date: trade date

Return as a JSON array of trade objects. Each object should have: {fundName, ticker, company, direction, shares, date}`;
  
  console.log(`[ARK Scraper] Starting scrape`);
  const result = await executeAIBrowserTask(task, { maxSteps: 15 });
  
  if (!result.success) {
    console.error(`[ARK Scraper] Failed: ${result.error}`);
    return [];
  }
  
  if (!result.data || result.data === null) {
    console.warn(`[ARK Scraper] Success but no data returned. Steps:`, result.steps);
    return [];
  }
  
  try {
    const trades = Array.isArray(result.data) ? result.data : [result.data];
    console.log(`[ARK Scraper] Successfully extracted ${trades.length} trades`);
    return trades;
  } catch (error) {
    console.error(`[ARK Scraper] Error processing data:`, error);
    return [];
  }
}

export async function scrapeYouTubeVideos(channelNames: string[]): Promise<any[]> {
  const channelsStr = channelNames.join(", ");

  const task = `You are a YouTube video scraper. Your goal is to find recent videos from specific trading channels.

IMPORTANT: For each channel name: ${channelsStr}

Step-by-step instructions:
1. Navigate to: https://www.youtube.com/results?search_query=[CHANNEL_NAME]&sp=CAI%253D (this sorts by upload date)
2. Wait for the page to load completely
3. Extract video data from the search results page
4. For EACH video in the results (get at least 3 per channel):
   - Find the video title (usually in an <a> tag with id containing "video-title")
   - Find the video URL (href attribute, should be /watch?v=...)
   - Find the channel name (verify it matches the search)
   - Find the upload date (look for text like "1 day ago", "2 weeks ago")
   - Find view count if available
   - Find the video thumbnail URL
   - Extract any visible description text

CRITICAL: Make sure to capture:
- title: exact video title text
- url: complete YouTube URL (https://www.youtube.com/watch?v=...)
- channel: channel name
- date: relative date string (e.g., "1 day ago")
- views: view count string (e.g., "10K views")
- thumbnail: thumbnail image URL
- description: short description if visible

After extracting all videos from all channels, return a JSON array with this exact structure:
[
  {
    "title": "video title here",
    "channel": "channel name",
    "url": "https://www.youtube.com/watch?v=...",
    "date": "1 day ago",
    "views": "10K views",
    "thumbnail": "https://...",
    "description": "video description"
  }
]

Make sure EVERY video object has a non-empty title and url field. If you cannot find these, skip that video.`;

  console.log(`[YouTube Scraper] Starting scrape for channels: ${channelsStr}`);
  const result = await executeAIBrowserTask(task, { maxSteps: 25 });
  
  if (!result.success) {
    console.error(`[YouTube Scraper] Failed: ${result.error}`);
    return [];
  }
  
  if (!result.data || result.data === null) {
    console.warn(`[YouTube Scraper] Success but no data returned. Steps:`, result.steps);
    return [];
  }
  
  try {
    const videos = Array.isArray(result.data) ? result.data : [result.data];
    console.log(`[YouTube Scraper] Successfully extracted ${videos.length} videos`);
    return videos;
  } catch (error) {
    console.error(`[YouTube Scraper] Error processing data:`, error);
    return [];
  }
}

export async function getStockPrice(ticker: string): Promise<any> {
  const task = `Go to Yahoo Finance (https://finance.yahoo.com/quote/${ticker}) and get the current stock price for ${ticker}. Extract the following information as a JSON object:
- price: current stock price (number)
- change: price change from previous close (number)
- changePercent: percentage change (number)
- previousClose: previous day's close price (number)
- dayRange: day's high and low range (string like "150.00 - 155.00")
- volume: trading volume (number if available)

Return ONLY the JSON object with this data, no other text.`;

  console.log(`[Stock Price Scraper] Starting scrape for ${ticker}`);
  const result = await executeAIBrowserTask(task, { maxSteps: 10 });
  
  if (!result.success) {
    console.error(`[Stock Price Scraper] Failed: ${result.error}`);
    return null;
  }
  
  if (!result.data || result.data === null) {
    console.warn(`[Stock Price Scraper] Success but no data returned. Steps:`, result.steps);
    return null;
  }
  
  console.log(`[Stock Price Scraper] Successfully extracted data for ${ticker}:`, result.data);
  return result.data;
}
