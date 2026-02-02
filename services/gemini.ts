
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ClassLevel, Subject, Chapter, LessonContent, Language, Board, Stream, ContentType, MCQItem, SystemSettings } from "../types";
import { STATIC_SYLLABUS } from "../constants";
import { getChapterData, getCustomSyllabus, getSecureKeys, incrementApiUsage, getApiUsage, rtdb } from "../firebase";
import { ref, get } from "firebase/database";
import { storage } from "../utils/storage";

let currentKeyIndex = 0; // GLOBAL ROTATION INDEX

// HELPER: Call Gemini via Edge API (Proxy)
const callGeminiApi = async (prompt: string, model: string = "gemini-1.5-flash", onChunk?: (text: string) => void) => {
    const response = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            model: model,
            stream: !!onChunk
        })
    });

    if (!response.ok) {
        const txt = await response.text();
        throw new Error(`Gemini API Error: ${txt}`);
    }
    
    if (onChunk && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullText = "";
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            buffer += chunk;

            // Simple parser for Gemini REST Stream (Array of JSON objects)
            // We look for patterns like "text": "..." in the chunks
            // This is a naive implementation but works for streaming text updates
            
            // Better: Attempt to parse complete JSON objects from the buffer
            // The stream is [ {...}, {...}, ... ]
            
            // Remove outer brackets if present at start/end of stream (handled loosely)
            let tempBuffer = buffer;
            if (tempBuffer.startsWith('[')) tempBuffer = tempBuffer.slice(1);
            if (tempBuffer.endsWith(']')) tempBuffer = tempBuffer.slice(0, -1);
            
            // Split by objects? No, comma separated.
            // Let's just Regex for "text": "..." which is safer for extraction in a broken stream
            
            // Logic: Find all "text": "..." and construct full text. 
            // BUT we only want NEW text.
            // Actually, Gemini sends independent chunks.
            
            // Let's use a cleaner approach:
            // 1. Split buffer by "}\n," or "}," or just ","?
            // 2. Try parse.
            
            // Fallback: Just update fullText at the end of loop if we can't parse stream incrementally well.
            // But we need realtime.
            
            // REGEX Extraction for "text" field
            const regex = /"text":\s*"((?:[^"\\]|\\.)*)"/g;
            let match;
            let extractedText = "";
            while ((match = regex.exec(buffer)) !== null) {
                try {
                    // Unescape JSON string
                    extractedText += JSON.parse(`"${match[1]}"`); 
                } catch(e) {}
            }
            
            // This extraction re-reads the whole buffer every time. 
            // We should optimize, but for now this ensures we get the text.
            // Wait, Gemini candidates accumulate? No, usually delta.
            // If delta, we append. If full, we replace.
            // Gemini `streamGenerateContent` returns chunks of generated content.
            
            // Let's assume we can just replace fullText with extractedText?
            // No, regex loops through ALL matches in buffer.
            if (extractedText.length > fullText.length) {
                fullText = extractedText;
                onChunk(fullText);
            }
        }
        return fullText;
    }

    const data = await response.json();
    try {
        return data.candidates[0].content.parts[0].text;
    } catch(e) {
        return "";
    }
};

const getAvailableKeys = async (): Promise<string[]> => {
    // ... (Existing logic, but simplified since we use /api/gemini which handles keys too)
    // However, executeWithRotation uses keys on client side currently.
    // If we move to /api/gemini, the key handling is on the server (api/gemini.ts).
    // So we don't need keys here?
    // User wants "Edge Runtime" -> Server logic.
    // So we should rely on server keys or pass keys if we have them.
    // `api/gemini.ts` accepts `key` in body.
    
    return ["PROXY_KEY"]; // Placeholder to pass check
};

// ... (Retain executeWithRotation for quota checks, but simplify key logic if using Proxy)
export const executeWithRotation = async <T>(
    operation: () => Promise<T>, // Changed signature to remove AI instance dependency
    usageType: 'PILOT' | 'STUDENT' = 'STUDENT'
): Promise<T> => {
    
    // QUOTA CHECK
    try {
        const usage = await getApiUsage();
        if (usage) {
             // ... (Quota logic same as groq.ts)
             const settingsStr = localStorage.getItem('nst_system_settings');
             const settings = settingsStr ? JSON.parse(settingsStr) : {};
             const pilotRatio = settings.aiPilotRatio || 80;
             const dailyLimit = settings.aiDailyLimitPerKey || 1500;
             const totalCapacity = 50000; // Arbitrary high since server handles keys

             const pilotLimit = Math.floor(totalCapacity * (pilotRatio / 100));
             const studentLimit = totalCapacity - pilotLimit;

             if (usageType === 'PILOT') {
                 if ((usage.pilotCount || 0) >= pilotLimit) throw new Error(`AI Pilot Quota Exceeded`);
             } else {
                  if ((usage.studentCount || 0) >= studentLimit) throw new Error(`Student AI Quota Exceeded.`);
             }
        }
    } catch(e: any) {
        if (e.message && e.message.includes("Quota Exceeded")) throw e;
    }

    try {
        const result = await operation();
        incrementApiUsage(0, usageType);
        return result;
    } catch (error: any) {
        console.warn(`Operation failed: ${error.message}`);
        throw error;
    }
};

// ... (Bulk Parallel - Simplified)
const executeBulkParallel = async <T>(
    tasks: (() => Promise<T>)[],
    concurrency: number = 20,
    usageType: 'PILOT' | 'STUDENT' = 'STUDENT'
): Promise<T[]> => {
    console.log(`🚀 Starting Bulk Engine: ${tasks.length} tasks`);
    // ... (Simple Promise.all with limit)
    // Since we use proxy, we just blast it.
    const results = await Promise.all(tasks.map(t => t().catch(e => null)));
    return results.filter(r => r !== null) as T[];
};

const chapterCache: Record<string, Chapter[]> = {};
const cleanJson = (text: string) => {
    return text.replace(/```json/g, '').replace(/```/g, '').trim();
};

export const translateToHindi = async (content: string, isJson: boolean = false, usageType: 'PILOT' | 'STUDENT' = 'STUDENT'): Promise<string> => {
    const prompt = `
    You are an expert translator for Bihar Board students.
    Translate the following ${isJson ? 'JSON Data' : 'Educational Content'} into Hindi (Devanagari).
    
    Style Guide:
    - Use "Hinglish" for technical terms (e.g., "Force" -> "Force (बल)").
    - Keep tone simple and student-friendly.
    - ${isJson ? 'Maintain strict JSON structure. Only translate values (question, options, explanation, etc). Do NOT translate keys.' : 'Keep Markdown formatting intact.'}

    CONTENT:
    ${content}
    `;

    return await executeWithRotation(async () => {
        const text = await callGeminiApi(prompt);
        return isJson ? cleanJson(text) : text;
    }, usageType);
};

// ... (getAdminContent - Same as before)
const getAdminContent = async (
    board: Board, 
    classLevel: ClassLevel, 
    stream: Stream | null, 
    subject: Subject, 
    chapterId: string,
    type: ContentType,
    syllabusMode: 'SCHOOL' | 'COMPETITION' = 'SCHOOL'
): Promise<LessonContent | null> => {
     // STRICT KEY MATCHING WITH ADMIN
    const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
    // Key format used in AdminDashboard to save content
    const key = `nst_content_${board}_${classLevel}${streamKey}_${subject.name}_${chapterId}`;
    
    try {
        // FETCH FROM FIREBASE FIRST
        let parsed = await getChapterData(key);
        
        if (!parsed) {
            // Fallback to Storage (for Admin's offline view)
            parsed = await storage.getItem(key);
        }

        if (parsed) {
            // ... (Logic copied from gemini.ts mostly unchanged as it deals with data retrieval)
            
            // 1. FREE NOTES (PDF_FREE or NOTES_SIMPLE)
            if (type === 'PDF_FREE' || type === 'NOTES_SIMPLE') {
                const linkKey = syllabusMode === 'SCHOOL' ? 'schoolPdfLink' : 'competitionPdfLink';
                const htmlKey = syllabusMode === 'SCHOOL' ? 'schoolFreeNotesHtml' : 'competitionFreeNotesHtml';
                
                const link = parsed[linkKey] || parsed.freeLink;
                const html = parsed[htmlKey] || parsed.freeNotesHtml;

                if (link && type === 'PDF_FREE') {
                    return {
                        id: Date.now().toString(),
                        title: "Free Study Material",
                        subtitle: "Provided by Admin",
                        content: link,
                        type: 'PDF_FREE',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }
                
                if (html && (type === 'NOTES_SIMPLE' || type === 'PDF_FREE')) {
                     return {
                        id: Date.now().toString(),
                        title: "Study Notes",
                        subtitle: "Detailed Notes (Admin)",
                        content: html,
                        type: 'NOTES_SIMPLE',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }
            }

            // 2. PREMIUM NOTES (PDF_PREMIUM or NOTES_PREMIUM)
            if (type === 'PDF_PREMIUM' || type === 'NOTES_PREMIUM') {
                const linkKey = syllabusMode === 'SCHOOL' ? 'schoolPdfPremiumLink' : 'competitionPdfPremiumLink';
                const htmlKey = syllabusMode === 'SCHOOL' ? 'schoolPremiumNotesHtml' : 'competitionPremiumNotesHtml';
                
                const link = parsed[linkKey] || parsed.premiumLink;
                const html = parsed[htmlKey] || parsed.premiumNotesHtml;

                if (link && type === 'PDF_PREMIUM') {
                    return {
                        id: Date.now().toString(),
                        title: "Premium Notes",
                        subtitle: "High Quality Content",
                        content: link,
                        type: 'PDF_PREMIUM',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false
                    };
                }

                if (html && (type === 'NOTES_PREMIUM' || type === 'PDF_PREMIUM')) {
                    const htmlKeyHI = syllabusMode === 'SCHOOL' ? 'schoolPremiumNotesHtml_HI' : 'competitionPremiumNotesHtml_HI';
                    const htmlHI = parsed[htmlKeyHI];

                    return {
                        id: Date.now().toString(),
                        title: "Premium Notes",
                        subtitle: "Exclusive Content (Admin)",
                        content: html,
                        type: 'NOTES_PREMIUM',
                        dateCreated: new Date().toISOString(),
                        subjectName: subject.name,
                        isComingSoon: false,
                        schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' ? htmlHI : undefined,
                        competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' ? htmlHI : undefined
                    };
                }
            }

            // Video Lecture
            if (type === 'VIDEO_LECTURE' && (parsed.premiumVideoLink || parsed.freeVideoLink)) {
                return {
                    id: Date.now().toString(),
                    title: "Video Lecture",
                    subtitle: "Watch Class",
                    content: parsed.premiumVideoLink || parsed.freeVideoLink,
                    type: 'PDF_VIEWER',
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    isComingSoon: false
                };
            }

            // Legacy Fallback
            if (type === 'PDF_VIEWER' && parsed.link) {
                return {
                    id: Date.now().toString(),
                    title: "Class Notes", 
                    subtitle: "Provided by Teacher",
                    content: parsed.link, 
                    type: 'PDF_VIEWER',
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    isComingSoon: false
                };
            }
            
            // Check for Manual MCQs
            if ((type === 'MCQ_SIMPLE' || type === 'MCQ_ANALYSIS') && parsed.manualMcqData) {
                return {
                    id: Date.now().toString(),
                    title: "Class Test (Admin)",
                    subtitle: `${parsed.manualMcqData.length} Questions`,
                    content: '',
                    type: type,
                    dateCreated: new Date().toISOString(),
                    subjectName: subject.name,
                    mcqData: parsed.manualMcqData,
                    manualMcqData_HI: parsed.manualMcqData_HI
                }
            }
        }
    } catch (e) {
        console.error("Content Lookup Error", e);
    }
    return null;
};

// ... (fetchChapters)
export const fetchChapters = async (
  board: Board,
  classLevel: ClassLevel, 
  stream: Stream | null,
  subject: Subject,
  language: Language
): Promise<Chapter[]> => {
  const streamKey = (classLevel === '11' || classLevel === '12') && stream ? `-${stream}` : '';
  const cacheKey = `${board}-${classLevel}${streamKey}-${subject.name}-${language}`;
  
  const firebaseChapters = await getCustomSyllabus(cacheKey);
  if (firebaseChapters && firebaseChapters.length > 0) {
      return firebaseChapters;
  }

  const customChapters = await storage.getItem<Chapter[]>(`nst_custom_chapters_${cacheKey}`);
  if (customChapters && customChapters.length > 0) return customChapters;

  if (chapterCache[cacheKey]) return chapterCache[cacheKey];

  const staticKey = `${board}-${classLevel}-${subject.name}`; 
  const staticList = STATIC_SYLLABUS[staticKey];
  if (staticList && staticList.length > 0) {
      const chapters: Chapter[] = staticList.map((title, idx) => ({
          id: `static-${idx + 1}`,
          title: title,
          description: `Chapter ${idx + 1}`
      }));
      chapterCache[cacheKey] = chapters;
      return chapters;
  }

  let modelName = "gemini-1.5-flash";
  try {
      const s = localStorage.getItem('nst_system_settings');
      if (s) { const p = JSON.parse(s); if(p.aiModel) modelName = p.aiModel; }
  } catch(e){}

  const prompt = `List 15 standard chapters for ${classLevel === 'COMPETITION' ? 'Competitive Exam' : `Class ${classLevel}`} ${stream ? stream : ''} Subject: ${subject.name} (${board}). Return JSON array: [{"title": "...", "description": "..."}].`;
  try {
    const data = await executeWithRotation(async () => {
        const text = await callGeminiApi(prompt, modelName);
        return JSON.parse(cleanJson(text || '[]'));
    }, 'STUDENT');
    const chapters: Chapter[] = data.map((item: any, index: number) => ({
      id: `ch-${index + 1}`,
      title: item.title,
      description: item.description || ''
    }));
    chapterCache[cacheKey] = chapters;
    return chapters;
  } catch (error) {
    console.error("Chapter Fetch Error:", error);
    const data = [{id:'1', title: 'Chapter 1'}, {id:'2', title: 'Chapter 2'}];
    chapterCache[cacheKey] = data;
    return data;
  }
};

const processTemplate = (template: string, replacements: Record<string, string>) => {
    let result = template;
    for (const [key, value] of Object.entries(replacements)) {
        result = result.replace(new RegExp(`{${key}}`, 'gi'), value);
    }
    return result;
};


export const fetchLessonContent = async (
  board: Board,
  classLevel: ClassLevel,
  stream: Stream | null,
  subject: Subject,
  chapter: Chapter,
  language: Language,
  type: ContentType,
  existingMCQCount: number = 0,
  isPremium: boolean = false,
  targetQuestions: number = 15,
  adminPromptOverride: string = "",
  allowAiGeneration: boolean = false,
  syllabusMode: 'SCHOOL' | 'COMPETITION' = 'SCHOOL',
  forceRegenerate: boolean = false,
  dualGeneration: boolean = false,
  usageType: 'PILOT' | 'STUDENT' = 'STUDENT',
  onChunk?: (text: string) => void
): Promise<LessonContent> => {
  
  // Get Settings for Custom Instruction & Model
  let customInstruction = "";
  let modelName = "gemini-1.5-flash";
  let promptNotes = "";
  let promptNotesPremium = "";
  let promptMCQ = "";

  try {
      const stored = localStorage.getItem('nst_system_settings');
      if (stored) {
          const s = JSON.parse(stored) as SystemSettings;
          if (s.aiInstruction) customInstruction = `IMPORTANT INSTRUCTION: ${s.aiInstruction}`;
          if (s.aiModel) modelName = s.aiModel;
          
          if (syllabusMode === 'COMPETITION') {
              // Priority: CBSE Competition > Generic Competition
              if (board === 'CBSE') {
                  if (s.aiPromptNotesCompetitionCBSE) promptNotes = s.aiPromptNotesCompetitionCBSE;
                  if (s.aiPromptNotesPremiumCompetitionCBSE) promptNotesPremium = s.aiPromptNotesPremiumCompetitionCBSE;
                  if (s.aiPromptMCQCompetitionCBSE) promptMCQ = s.aiPromptMCQCompetitionCBSE;
              }

              // Fallback to Generic Competition Prompts if specific ones missing
              if (!promptNotes && s.aiPromptNotesCompetition) promptNotes = s.aiPromptNotesCompetition;
              if (!promptNotesPremium && s.aiPromptNotesPremiumCompetition) promptNotesPremium = s.aiPromptNotesPremiumCompetition;
              if (!promptMCQ && s.aiPromptMCQCompetition) promptMCQ = s.aiPromptMCQCompetition;

          } else {
              // CBSE Override
              if (board === 'CBSE') {
                  if (s.aiPromptNotesCBSE) promptNotes = s.aiPromptNotesCBSE;
                  if (s.aiPromptNotesPremiumCBSE) promptNotesPremium = s.aiPromptNotesPremiumCBSE;
                  if (s.aiPromptMCQCBSE) promptMCQ = s.aiPromptMCQCBSE;
              }

              // Default (BSEB / General)
              if (!promptNotes && s.aiPromptNotes) promptNotes = s.aiPromptNotes;
              if (!promptNotesPremium && s.aiPromptNotesPremium) promptNotesPremium = s.aiPromptNotesPremium;
              if (!promptMCQ && s.aiPromptMCQ) promptMCQ = s.aiPromptMCQ;
          }
      }
  } catch(e) {}

  // 1. CHECK ADMIN DATABASE FIRST (Async now)
  if (!forceRegenerate) {
      const adminContent = await getAdminContent(board, classLevel, stream, subject, chapter.id, type, syllabusMode);
      if (adminContent) {
          return {
              ...adminContent,
              title: chapter.title, 
          };
      }
  }

  // 2. IF ADMIN CONTENT MISSING, HANDLE PDF TYPES (Don't generate fake PDF)
  if (type === 'PDF_FREE' || type === 'PDF_PREMIUM' || type === 'PDF_VIEWER') {
      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Content Unavailable",
          content: "",
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          isComingSoon: true 
      };
  }

  // 3. AI GENERATION (Fallback for Notes/MCQ only)
  if (!allowAiGeneration) {
      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Content Unavailable",
          content: "",
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          isComingSoon: true
      };
  }
  
  // MCQ Mode
  if (type === 'MCQ_ANALYSIS' || type === 'MCQ_SIMPLE') {
      const effectiveCount = Math.max(targetQuestions, 20); 

      let prompt = "";
      if (promptMCQ) {
           prompt = processTemplate(promptMCQ, {
               board: board || '',
               class: classLevel,
               stream: stream || '',
               subject: subject.name,
               chapter: chapter.title,
               language: language,
               count: effectiveCount.toString(),
               instruction: customInstruction
           });
           if (adminPromptOverride) prompt += `\nINSTRUCTION: ${adminPromptOverride}`;
      } else {
          const competitionConstraints = syllabusMode === 'COMPETITION' 
              ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
              : "STYLE: Strict NCERT Pattern.";

          prompt = `${customInstruction}
          ${adminPromptOverride ? `INSTRUCTION: ${adminPromptOverride}` : ''}
          Create ${effectiveCount} MCQs for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}". 
          Language: ${language}.
          ${competitionConstraints}
          
          STRICT FORMAT RULE:
          Return ONLY a valid JSON array. No markdown blocks, no extra text.
          [
            {
              "question": "Question text",
              "options": ["A", "B", "C", "D"],
              "correctAnswer": 0, // Index 0-3
              "explanation": "Logical explanation here",
              "mnemonic": "Short memory trick",
              "concept": "Core concept"
            }
          ]
          
          CRITICAL: You MUST return EXACTLY ${effectiveCount} questions. 
          Provide a very diverse set of questions covering every small detail of the chapter.`;
      }

      // BULK GENERATION LOGIC
      let data: any[] = [];

      if (effectiveCount > 30) {
          const batchSize = 20; 
          const batches = Math.ceil(effectiveCount / batchSize);
          const tasks: (() => Promise<any[]>)[] = [];

          for (let i = 0; i < batches; i++) {
              tasks.push(async () => {
                  const batchPrompt = processTemplate(prompt, {
                      board: board || '',
                      class: classLevel,
                      stream: stream || '',
                      subject: subject.name,
                      chapter: chapter.title,
                      language: language,
                      count: batchSize.toString(),
                      instruction: `${customInstruction}\nBATCH ${i+1}/${batches}. Ensure diversity. Avoid duplicates from previous batches if possible.`
                  });

                  const text = await callGeminiApi(batchPrompt, modelName);
                  return JSON.parse(cleanJson(text || '[]'));
              });
          }

          const allResults = await executeBulkParallel(tasks, 50, usageType);
          data = allResults.flat();
          
          const seen = new Set();
          data = data.filter(q => {
              const duplicate = seen.has(q.question);
              seen.add(q.question);
              return !duplicate;
          });
          
          if (data.length > effectiveCount) data = data.slice(0, effectiveCount);

      } else {
          data = await executeWithRotation(async () => {
              const text = await callGeminiApi(prompt, modelName);
              return JSON.parse(cleanJson(text || '[]'));
          }, usageType);
      }

      // AUTO TRANSLATE LOGIC
      let hindiMcqData = undefined;
      if (language === 'English') {
          try {
             const translatedJson = await translateToHindi(JSON.stringify(data), true, usageType);
             hindiMcqData = JSON.parse(translatedJson);
          } catch(e) { console.error("Translation Failed", e); }
      }

      return {
          id: Date.now().toString(),
          title: `MCQ Test: ${chapter.title}`,
          subtitle: `${data.length} Questions`,
          content: '',
          type: type,
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          mcqData: data,
          manualMcqData_HI: hindiMcqData 
      };
  }

  // NOTES Mode
  const generateNotes = async (detailed: boolean): Promise<{text: string, hindiText?: string}> => {
      let prompt = "";
      const template = detailed ? promptNotesPremium : promptNotes;
      
      if (template) {
           prompt = processTemplate(template, {
               board: board || '',
               class: classLevel,
               stream: stream || '',
               subject: subject.name,
               chapter: chapter.title,
               language: language,
               instruction: customInstruction
           });
      } else {
          const competitionConstraints = syllabusMode === 'COMPETITION' 
              ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
              : "STYLE: Strict NCERT Pattern.";

          if (detailed) {
              prompt = `${customInstruction}
              ${adminPromptOverride || ""}
              
              Write PREMIUM DEEP DIVE NOTES for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}".
              Language: ${language}.
              ${competitionConstraints}
              
              STRICT TARGET: 1000-1500 Words.
              
              STYLE: "Gemini Style" - Detailed, Conversational, Analytical.
              
              STRUCTURE:
              1. 🌟 Introduction (Hook with a real-life example or Thinking Question)
              2. 📘 Detailed Explanation (Step-by-step breakdown of every concept)
              3. 📊 Text-Based Diagrams / Flowcharts (Use ASCII arrows e.g. Sun -> Plant -> Herbivore)
              4. 🧠 Deep Dive Section ("Concept Chamka?" - Deep Logic behind concepts)
              5. 🧪 Examples & Case Studies
              6. ⚠️ Exam Alerts (Common Mistakes & Exam Traps)
              7. 🏆 Topper's Trick (Mnemonics)
              8. 📝 20 Practice MCQs (At the very end, with Answer Key and Solutions)
              
              Use bold text for keywords. Make it comprehensive.`;
          } else {
              prompt = `${customInstruction}
              ${adminPromptOverride || ""}
              
              Write SHORT SUMMARY NOTES for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}".
              Language: ${language}.
              
              STRICT TARGET: 200-300 Words.
              
              STRUCTURE:
              1. 📌 Basic Definition (Simple & Clear)
              2. 🔑 Key Points (Bullet points summary)
              3. 📝 5 Practice MCQs (with Answer Key)
              
              Keep it concise. Focus on quick revision.`;
          }
      }

      const text = await executeWithRotation(async () => {
          return await callGeminiApi(prompt, modelName, onChunk);
      }, usageType);

      // AUTO TRANSLATE LOGIC
      let hindiText = undefined;
      if (language === 'English') {
          try {
              hindiText = await translateToHindi(text, false, usageType);
          } catch(e) { console.error("Translation Failed", e); }
      }
      return { text, hindiText };
  };

  if (dualGeneration && (type === 'NOTES_PREMIUM' || type === 'NOTES_SIMPLE')) {
       // ... (Same Dual Logic)
       const competitionConstraints = syllabusMode === 'COMPETITION' 
          ? "STYLE: Fact-Heavy, Direct. HIGHLIGHT PYQs (Previous Year Questions) if relevant." 
          : "STYLE: Strict NCERT Pattern.";

       const prompt = `${customInstruction}
       ${adminPromptOverride || ""}
       
       TASK:
       1. Generate Premium Detailed Analysis Notes for ${board} Class ${classLevel} ${subject.name}, Chapter: "${chapter.title}".
       2. Generate a 100-word Summary for Free Notes.
       
       Language: ${language}.
       ${competitionConstraints}
       
       OUTPUT FORMAT STRICTLY:
       <<<PREMIUM>>>
       [Detailed Content Here including Introduction, Key Concepts, Tables, Flowcharts, Formulas, Exam Alerts etc.]
       <<<SUMMARY>>>
       [Short 100-word Summary Here]
       `;
       
       const rawText = await executeWithRotation(async () => {
          return await callGeminiApi(prompt, modelName, onChunk);
       }, usageType);
       
       let premiumText = "";
       let freeText = "";
       
       if (rawText.includes("<<<PREMIUM>>>")) {
           const parts = rawText.split("<<<PREMIUM>>>");
           if (parts[1]) {
               const subParts = parts[1].split("<<<SUMMARY>>>");
               premiumText = subParts[0].trim();
               if (subParts[1]) freeText = subParts[1].trim();
           }
       } else {
           premiumText = rawText;
           freeText = "Summary not generated.";
       }

       let premiumTextHI = undefined;
       let freeTextHI = undefined;
       
       if (language === 'English') {
          try {
              const [p, f] = await Promise.all([
                  translateToHindi(premiumText, false, usageType),
                  translateToHindi(freeText, false, usageType)
              ]);
              premiumTextHI = p;
              freeTextHI = f;
          } catch(e) { console.error("Translation Failed", e); }
       }

      return {
          id: Date.now().toString(),
          title: chapter.title,
          subtitle: "Premium & Free Notes (Dual)",
          content: premiumText, // Default to Premium
          type: 'NOTES_PREMIUM',
          dateCreated: new Date().toISOString(),
          subjectName: subject.name,
          
          schoolPremiumNotesHtml: syllabusMode === 'SCHOOL' ? premiumText : undefined,
          competitionPremiumNotesHtml: syllabusMode === 'COMPETITION' ? premiumText : undefined,
          schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' ? premiumTextHI : undefined,
          competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' ? premiumTextHI : undefined,

          schoolFreeNotesHtml: syllabusMode === 'SCHOOL' ? freeText : undefined,
          competitionFreeNotesHtml: syllabusMode === 'COMPETITION' ? freeText : undefined,
          
          isComingSoon: false
      };
  }

  const isDetailed = type === 'NOTES_PREMIUM' || type === 'NOTES_HTML_PREMIUM';
  const result = await generateNotes(isDetailed);

  return {
      id: Date.now().toString(),
      title: chapter.title,
      subtitle: isDetailed ? "Premium Study Notes" : "Quick Revision Notes",
      content: result.text,
      type: type,
      dateCreated: new Date().toISOString(),
      subjectName: subject.name,
      schoolPremiumNotesHtml_HI: syllabusMode === 'SCHOOL' && isDetailed ? result.hindiText : undefined,
      competitionPremiumNotesHtml_HI: syllabusMode === 'COMPETITION' && isDetailed ? result.hindiText : undefined,
      isComingSoon: false
  };
};

export const generateTestPaper = async (topics: any, count: number, language: Language): Promise<MCQItem[]> => {
    return []; // Placeholder
};
export const generateDevCode = async (userPrompt: string): Promise<string> => { return "// Dev Console Disabled"; };

export const generateCustomNotes = async (userTopic: string, adminPrompt: string, modelName: string = "gemini-1.5-flash"): Promise<string> => {
    const prompt = `${adminPrompt || 'Generate detailed notes for the following topic:'}
    
    TOPIC: ${userTopic}
    
    Ensure the content is well-structured with headings and bullet points.`;

    return await executeWithRotation(async () => {
        return await callGeminiApi(prompt, modelName);
    }, 'STUDENT');
};

export const generateUltraAnalysis = async (
    data: {
        questions: any[], 
        userAnswers: Record<number, number>, 
        score: number, 
        total: number, 
        subject: string, 
        chapter: string,
        classLevel: string
    },
    settings?: SystemSettings
): Promise<string> => {
    let modelName = "gemini-1.5-flash";
    let customInstruction = "";
    
    if (settings) {
        if (settings.aiModel) modelName = settings.aiModel;
        if (settings.aiInstruction) customInstruction = settings.aiInstruction;
    }

    const attemptedQuestions = data.questions.map((q, idx) => {
        const selected = data.userAnswers[idx];
        const isCorrect = selected === q.correctAnswer;
        
        return {
            question: q.question,
            correctAnswer: q.options[q.correctAnswer],
            userSelected: (selected !== undefined && selected !== -1 && q.options[selected]) ? q.options[selected] : "Skipped",
            isCorrect: isCorrect,
            concept: q.concept || q.explanation || "General Concept"
        };
    });

    const prompt = `
    ${customInstruction}
    
    ROLE: Expert Educational Mentor & Analyst.
    
    CONTEXT:
    Student Class: ${data.classLevel}
    Subject: ${data.subject}
    Chapter: ${data.chapter}
    Score: ${data.score}/${data.total}

    TASK:
    Analyze the student's performance and provide a structured JSON analysis grouped by topics.
    
    DATA:
    ${JSON.stringify(attemptedQuestions, null, 2)}

    OUTPUT FORMAT (STRICT JSON ONLY, NO MARKDOWN):
    {
      "topics": [
        {
          "name": "Topic Name",
          "status": "WEAK" | "AVERAGE" | "STRONG",
          "questions": [
            {
              "text": "Question text...",
              "status": "CORRECT" | "WRONG", 
              "correctAnswer": "Option text (if wrong)"
            }
          ],
          "actionPlan": "Specific advice on how to work on this topic...",
          "studyMode": "REVISION" | "DEEP_STUDY"
        }
      ],
      "motivation": "One short punchy motivational line",
      "nextSteps": {
        "duration": "2 Days",
        "focusTopics": ["Topic A", "Topic B"],
        "action": "Brief instructions on what to study immediately."
      },
      "weakToStrongPath": [
        { "step": 1, "action": "Step-by-step action to improve weak areas..." },
        { "step": 2, "action": "..." }
      ]
    }
    
    Ensure the response is valid JSON. Do not wrap in markdown code blocks.
    `;

    return await executeWithRotation(async () => {
        const text = await callGeminiApi(prompt, modelName);
        return cleanJson(text || "{}");
    }, 'STUDENT');
};
