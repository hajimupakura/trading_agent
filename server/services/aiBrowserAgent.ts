/**
 * Custom AI Browser Agent using Puppeteer + Gemini 2.0 Flash
 * Prompt-driven web automation that runs entirely on your server
 */

import puppeteer, { Browser, Page } from "puppeteer";
import { invokeGemini } from "../_core/llm-gemini";

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
      
      // Get current page state
      const pageState = await getPageState(page);
      
      // Ask Gemini what to do next
      const action = await decideNextAction(task, pageState, steps);
      
      if (action.type === "complete") {
        steps.push("Task completed");
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
      
      let result = "";
      const tag = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : "";
      const classes = element.className ? `.${element.className.split(" ").join(".")}` : "";
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
}> {
  const prompt = `You are an AI browser automation agent. Your task is: "${task}"

Previous steps taken:
${previousSteps.join("\n")}

Current page state:
${pageState}

Based on the task and current page state, decide the next action. Respond in JSON format:
{
  "type": "navigate|click|type|extract|complete",
  "description": "Brief description of what you're doing",
  "target": "URL or CSS selector or text to type",
  "data": "extracted data (only if type is 'extract' or 'complete')"
}

Action types:
- navigate: Go to a URL
- click: Click an element (provide CSS selector)
- type: Type text into an input (provide CSS selector and text)
- extract: Extract data from current page
- complete: Task is finished (provide final extracted data)`;

  const response = await invokeGemini({
    messages: [
      {
        role: "system",
        content: "You are a browser automation agent. Always respond with valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.3,
  });

  try {
    const content = response.choices[0]?.message?.content || "{}";
    return JSON.parse(content);
  } catch (error) {
    // Fallback if JSON parsing fails
    return {
      type: "complete",
      description: "Unable to parse action",
      data: null,
    };
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
  
  const task = `Find the latest financial news articles about ${topicsStr} from Reuters, Bloomberg, or Yahoo Finance. Extract title, summary, URL, source, and date for each article. Return as JSON array.`;
  
  const result = await executeAIBrowserTask(task, { maxSteps: 15 });
  
  if (result.success && result.data) {
    try {
      return Array.isArray(result.data) ? result.data : [result.data];
    } catch {
      return [];
    }
  }
  
  return [];
}

export async function scrapeARKTrades(): Promise<any[]> {
  const task = `Go to ark-funds.com and find the latest daily trade data for all ARK ETFs. Extract fund name, ticker, company, direction (buy/sell), shares, and date. Return as JSON array.`;
  
  const result = await executeAIBrowserTask(task, { maxSteps: 15 });
  
  if (result.success && result.data) {
    try {
      return Array.isArray(result.data) ? result.data : [result.data];
    } catch {
      return [];
    }
  }
  
  return [];
}

export async function scrapeYouTubeVideos(channelNames: string[]): Promise<any[]> {
  const channelsStr = channelNames.join(", ");
  
  const task = `Search YouTube for the latest videos from these channels: ${channelsStr}. Get the 3 most recent videos from each. Extract title, channel, URL, date, views, and description. Return as JSON array.`;
  
  const result = await executeAIBrowserTask(task, { maxSteps: 20 });
  
  if (result.success && result.data) {
    try {
      return Array.isArray(result.data) ? result.data : [result.data];
    } catch {
      return [];
    }
  }
  
  return [];
}

export async function getStockPrice(ticker: string): Promise<any> {
  const task = `Go to Yahoo Finance and get the current stock price for ${ticker}. Extract current price, change, change percentage, previous close, and day's range. Return as JSON object.`;
  
  const result = await executeAIBrowserTask(task, { maxSteps: 10 });
  
  return result.success ? result.data : null;
}
