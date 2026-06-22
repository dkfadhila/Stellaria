/**
 * AI Info Helper — fetches contextual descriptions for celestial objects
 * and natural-language search results from the Mimo API.
 */

export interface AIResult {
  text: string;
  error?: boolean;
}

/**
 * Fetch a short AI-generated description for a selected celestial object.
 * Works for stars, Messier objects, exoplanets, and anomalies.
 */
export async function fetchObjectInfo(
  objectType: 'star' | 'messier' | 'exoplanet' | 'anomaly',
  objectData: Record<string, any>,
  skyContext: { latitude: number; longitude: number; dateMs: number }
): Promise<AIResult> {
  let prompt = '';
  const lat = skyContext.latitude.toFixed(2);
  const lon = skyContext.longitude.toFixed(2);

  switch (objectType) {
    case 'star':
      prompt = `Provide a concise but informative description of the star "${objectData.name}" (HIP ${objectData.hip}, RA ${objectData.ra}°, Dec ${objectData.dec}°, magnitude ${objectData.mag}, spectral type ${objectData.spect}, constellation ${objectData.con}). Include: what type of star it is, estimated distance, key physical properties, any interesting facts or mythology, and whether it's visible from latitude ${lat}°, longitude ${lon}° right now. Keep it under 150 words. Use markdown.`;
      break;
    case 'messier':
      prompt = `Provide a concise description of Messier object M${objectData.m} (${objectData.name}, type: ${objectData.type}, constellation: ${objectData.const}, magnitude ${objectData.mag}). Include: what it is, distance, size, discovery history, observation tips (binoculars/telescope/naked eye), and any interesting facts. Keep it under 150 words. Use markdown.`;
      break;
    case 'exoplanet':
      prompt = `Provide a concise description of exoplanet ${objectData.name} orbiting host star ${objectData.host} (discovered ${objectData.year}, orbital period ${objectData.period} days, mass ${objectData.mass} Earth masses, radius ${objectData.radius} Earth radii, ${objectData.habitable ? 'in habitable zone' : 'not in habitable zone'}). Include: discovery method, habitability assessment, comparison to Earth, and significance. Keep it under 150 words. Use markdown.`;
      break;
    case 'anomaly':
      // Anomaly descriptions are already pre-computed, but we can enhance with AI
      prompt = `Explain the gravitational anomaly "${objectData.name}" at RA ${objectData.ra}°, Dec ${objectData.dec}°. Detection method: ${objectData.method}. Estimated mass: ${objectData.estimatedMass}. Object type: ${objectData.objectType}. Provide scientific context about how such objects are detected and what they mean for our understanding of the universe. Keep it under 150 words. Use markdown.`;
      break;
  }

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are STELLARIA AI, an expert astronomy guide. Provide accurate, concise, and engaging descriptions of celestial objects. Use markdown formatting. Keep responses under 150 words.'
          },
          { role: 'user', content: prompt }
        ],
        stream: false,
        max_tokens: 400
      })
    });

    if (!res.ok) {
      return { text: 'Failed to fetch AI description.', error: true };
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || 'No response from AI.';
    return { text };
  } catch (err: any) {
    return { text: `Error: ${err.message}`, error: true };
  }
}

/**
 * Natural language search — asks the AI to interpret a query and return
 * celestial object suggestions with coordinates.
 */
export interface AISearchResult {
  name: string;
  ra: number;
  dec: number;
  kind: string;
  description: string;
}

export async function naturalLanguageSearch(
  query: string,
  skyContext: { latitude: number; longitude: number; dateMs: number }
): Promise<AISearchResult[]> {
  const prompt = `The user is searching the night sky for: "${query}"

They are at latitude ${skyContext.latitude}°, longitude ${skyContext.longitude}°.

Identify up to 5 celestial objects that match this query. For each, provide:
- name: the common name
- ra: J2000 Right Ascension in degrees (0-360)
- dec: J2000 Declination in degrees (-90 to +90)
- kind: what type of object (star, galaxy, nebula, cluster, exoplanet, constellation, etc.)
- description: a very short (10 words) description

Respond as a JSON array. Only include objects you are confident about. If the query is ambiguous, make your best guess based on astronomical knowledge.

Example response format:
[{"name":"Betelgeuse","ra":88.79,"dec":7.41,"kind":"Red supergiant star","description":"Bright red star in Orion's shoulder"}]`;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: 'You are an astronomy expert. Respond ONLY with a valid JSON array. No markdown, no explanation, just the JSON array.'
          },
          { role: 'user', content: prompt }
        ],
        stream: false,
        max_tokens: 500,
        temperature: 0.3
      })
    });

    if (!res.ok) return [];

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || '[]';

    // Extract JSON from response (in case AI wraps it in markdown)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
      const results = JSON.parse(jsonMatch[0]);
      if (Array.isArray(results)) {
        return results.filter(r =>
          typeof r.ra === 'number' &&
          typeof r.dec === 'number' &&
          typeof r.name === 'string'
        ).slice(0, 5);
      }
    } catch {
      return [];
    }

    return [];
  } catch {
    return [];
  }
}
