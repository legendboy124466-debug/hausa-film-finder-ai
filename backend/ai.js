const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");

// Cache for AI responses to avoid repeated API calls
const aiResponseCache = new Map();
const cacheDuration = 5 * 60 * 1000; // 5 minutes

/**
 * Get AI response from Gemini API
 * @param {string} prompt - The user's prompt
 * @param {string} systemPrompt - System instruction/context
 * @returns {Promise<string>} AI response text
 */
async function getAIResponse(prompt, systemPrompt = "You are a helpful Hausa language assistant.") {
  // Check cache first
  const cacheKey = `${systemPrompt}:${prompt}`;
  if (aiResponseCache.has(cacheKey)) {
    const { timestamp, response } = aiResponseCache.get(cacheKey);
    if (Date.now() - timestamp < cacheDuration) {
      return response;
    }
    aiResponseCache.delete(cacheKey);
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY not configured");
  }

  const geminiModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    systemInstruction: { role: "user", parts: [{ text: systemPrompt }] },
    temperature: 0.7,
    maxOutputTokens: 1024,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
    }

    const data = await response.json();

    if (data.candidates && data.candidates[0] && data.candidates[0].content) {
      const aiText = data.candidates[0].content.parts[0].text;

      // Cache the response
      aiResponseCache.set(cacheKey, {
        timestamp: Date.now(),
        response: aiText,
      });

      return aiText;
    }

    throw new Error("Unexpected Gemini API response format");
  } catch (error) {
    console.error("AI service error:", error.message);
    throw error;
  }
}

/**
 * Format AI response for Hausa context
 * @param {string} responseText - Raw AI response
 * @returns {object} Formatted response with metadata
 */
function formatAIResponse(responseText) {
  return {
    success: true,
    response: responseText.trim(),
    timestamp: new Date().toISOString(),
    language: "hausa",
  };
}

/**
 * Handle security sanitization of prompts
 * @param {string} prompt - User prompt
 * @returns {string} Sanitized prompt
 */
function sanitizePrompt(prompt) {
  // Remove potentially dangerous content
  const sanitized = prompt
    .replace(/<script[^>]*>.*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .substring(0, 2000); // Limit length

  return sanitized.trim();
}

module.exports = {
  getAIResponse,
  formatAIResponse,
  sanitizePrompt,
};