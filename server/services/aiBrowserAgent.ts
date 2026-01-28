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

  console.log(`[News Scraper] Starting scrape for topics: ${topicsStr}`);

  // Try Puppeteer first, fallback to fetch if Chrome is not available
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Navigate to Yahoo Finance news
    await page.goto("https://finance.yahoo.com/topic/stock-market-news/", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Wait for articles to load
    await page.waitForSelector('li.js-stream-content', { timeout: 10000 });

    // Extract articles
    const articles = await page.evaluate(() => {
      const results: any[] = [];
      const articleElements = document.querySelectorAll('li.js-stream-content');

      articleElements.forEach((article, index) => {
        if (index >= 10) return; // Limit to 10 articles

        try {
          const titleEl = article.querySelector('h3 a') || article.querySelector('a h3');
          const summaryEl = article.querySelector('p');
          const timeEl = article.querySelector('time');

          const title = titleEl?.textContent?.trim();
          const url = titleEl?.getAttribute('href');
          const summary = summaryEl?.textContent?.trim() || '';
          const date = timeEl?.textContent?.trim() || '';

          if (title && url) {
            const fullUrl = url.startsWith('http') ? url : `https://finance.yahoo.com${url}`;
            results.push({
              title,
              summary: summary || title,
              url: fullUrl,
              source: "Yahoo Finance",
              date: date || "Recently"
            });
          }
        } catch (err) {
          console.log('Error parsing article:', err);
        }
      });

      return results;
    });

    await page.close();

    console.log(`[News Scraper] Successfully extracted ${articles.length} articles via Puppeteer`);
    return articles;

  } catch (error: any) {
    console.warn(`[News Scraper] Puppeteer scrape failed (${error.message}), trying fetch fallback...`);

    // Fallback: Use simple fetch to get Yahoo Finance RSS feed
    try {
      const response = await fetch('https://finance.yahoo.com/rss/topstories');
      const xml = await response.text();

      // Parse RSS XML manually (simple approach)
      const articles: any[] = [];
      const itemMatches = Array.from(xml.matchAll(/<item>(.*?)<\/item>/gs));

      for (const match of itemMatches) {
        const item = match[1];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/);
        const linkMatch = item.match(/<link>(.*?)<\/link>/);
        const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/);
        const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);

        if (titleMatch && linkMatch) {
          articles.push({
            title: titleMatch[1],
            summary: descMatch ? descMatch[1].replace(/<[^>]*>/g, '') : titleMatch[1],
            url: linkMatch[1],
            source: "Yahoo Finance (RSS)",
            date: pubDateMatch ? pubDateMatch[1] : "Recently"
          });
        }

        if (articles.length >= 10) break; // Limit to 10
      }

      console.log(`[News Scraper] Successfully extracted ${articles.length} articles via RSS fallback`);
      return articles;

    } catch (fallbackError: any) {
      console.error(`[News Scraper] Fallback also failed:`, fallbackError.message);
      return [];
    }
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
  const channelName = channelNames[0]; // Only scrape first channel

  console.log(`[YouTube Scraper] Starting direct HTML scrape for channel: ${channelName}`);

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // Search YouTube for channel and sort by upload date
    const searchQuery = encodeURIComponent(channelName);
    await page.goto(`https://www.youtube.com/results?search_query=${searchQuery}&sp=CAI%253D`, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Wait for video results
    await page.waitForSelector('ytd-video-renderer', { timeout: 10000 });

    // Extract the first (most recent) video
    const videos = await page.evaluate(() => {
      const results: any[] = [];
      const videoElements = document.querySelectorAll('ytd-video-renderer');

      // Only get the first video
      const firstVideo = videoElements[0];
      if (!firstVideo) return results;

      try {
        const titleEl = firstVideo.querySelector('#video-title');
        const channelEl = firstVideo.querySelector('#channel-name a, #text.ytd-channel-name');
        const thumbnailEl = firstVideo.querySelector('img');
        const metadataLines = firstVideo.querySelectorAll('#metadata-line span');

        const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('aria-label');
        const url = titleEl?.getAttribute('href');
        const channel = channelEl?.textContent?.trim();
        const thumbnail = thumbnailEl?.getAttribute('src');

        let views = '';
        let date = '';
        if (metadataLines.length >= 2) {
          views = metadataLines[0]?.textContent?.trim() || '';
          date = metadataLines[1]?.textContent?.trim() || '';
        }

        if (title && url) {
          const fullUrl = url.startsWith('http') ? url : `https://www.youtube.com${url}`;
          results.push({
            title,
            channel: channel || 'Unknown',
            url: fullUrl,
            date: date || 'Recently',
            views: views || '0 views',
            thumbnail: thumbnail || '',
            description: title // Use title as description for now
          });
        }
      } catch (err) {
        console.log('Error parsing video:', err);
      }

      return results;
    });

    await page.close();

    console.log(`[YouTube Scraper] Successfully extracted ${videos.length} video(s) via direct HTML`);
    return videos;

  } catch (error: any) {
    console.error(`[YouTube Scraper] Direct HTML scrape failed:`, error.message);
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
