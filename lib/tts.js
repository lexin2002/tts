import { getEndpoint } from './token.js';
import { delay, escapeXmlText, makeCORSHeaders } from './utils.js';

function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/[。！？\n]/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;
        
        if (trimmedSentence.length > maxChunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            
            for (let i = 0; i < trimmedSentence.length; i += maxChunkSize) {
                chunks.push(trimmedSentence.slice(i, i + maxChunkSize));
            }
        } else if ((currentChunk + trimmedSentence).length > maxChunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            currentChunk = trimmedSentence;
        } else {
            currentChunk += (currentChunk ? '。' : '') + trimmedSentence;
        }
    }
    
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, batchSize = 3, delayMs = 1000) {
    const audioChunks = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchPromises = batch.map(async (chunk, index) => {
            try {
                if (index > 0) {
                    await delay(index * 200);
                }
                return await getAudioChunk(chunk, voiceName, rate, pitch, volume, style, outputFormat);
            } catch (error) {
                console.error(`处理音频块失败 (批次 ${Math.floor(i/batchSize) + 1}, 块 ${index + 1}):`, error);
                throw error;
            }
        });
        
        try {
            const batchResults = await Promise.all(batchPromises);
            audioChunks.push(...batchResults);
            
            if (i + batchSize < chunks.length) {
                await delay(delayMs);
            }
        } catch (error) {
            console.error(`批次处理失败:`, error);
            throw error;
        }
    }
    
    return audioChunks;
}

export async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", rate = '+0%', pitch = '+0Hz', volume = '+0%', style = "general", outputFormat = "audio-24khz-48kbitrate-mono-mp3") {
    try {
        const cleanText = text.trim();
        if (!cleanText) {
            throw new Error("文本内容为空");
        }
        
        if (cleanText.length <= 1500) {
            const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat);
            return new Response(audioBlob, {
                headers: {
                    "Content-Type": "audio/mpeg",
                    ...makeCORSHeaders()
                }
            });
        }

        const chunks = optimizedTextSplit(cleanText, 1500);
        
        if (chunks.length > 40) {
            throw new Error(`文本过长，分块数量(${chunks.length})超过限制。请缩短文本或分批处理。`);
        }
        
        console.log(`文本已分为 ${chunks.length} 个块进行处理`);

        const audioChunks = await processBatchedAudioChunks(
            chunks, 
            voiceName, 
            rate, 
            pitch, 
            volume, 
            style, 
            outputFormat,
            3,
            800
        );

        const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
        return new Response(concatenatedAudio, {
            headers: {
                "Content-Type": "audio/mpeg",
                ...makeCORSHeaders()
            }
        });

    } catch (error) {
        console.error("语音合成失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: error.message || String(error),
                type: "api_error",
                param: `${voiceName}, ${rate}, ${pitch}, ${volume}, ${style}, ${outputFormat}`,
                code: "edge_tts_error"
            }
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }
}

async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat = 'audio-24khz-48kbitrate-mono-mp3', maxRetries = 3) {
    const retryDelay = 500;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
            
            let m = text.match(/\[(\d+)\]\s*?$/);
            let slien = 0;
            if (m && m.length == 2) {
                slien = parseInt(m[1]);
                text = text.replace(m[0], '');
            }
            
            if (!text.trim()) {
                throw new Error("文本块为空");
            }
            
            if (text.length > 2000) {
                throw new Error(`文本块过长: ${text.length} 字符，最大支持2000字符`);
            }
            
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: getSsml(text, voiceName, rate, pitch, volume, style, slien)
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        console.log(`频率限制，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
                } else if (response.status >= 500) {
                    if (attempt < maxRetries) {
                        console.log(`服务器错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
                } else {
                    throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
                }
            }

            return await response.blob();
            
        } catch (error) {
            if (attempt === maxRetries) {
                throw new Error(`音频生成失败（已重试${maxRetries}次）: ${error.message}`);
            }
            
            if (error.message.includes('fetch') || error.message.includes('network')) {
                console.log(`网络错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                await delay(retryDelay * (attempt + 1));
                continue;
            }
            
            throw error;
        }
    }
}

export function hasDirectives(text) {
    return /\[(?:pause|emphasis|rate|pitch|volume|style|say-as|sub)(?=[\]:])/.test(text);
}

export function convertDirectivesToSsml(text, voiceName, rate, pitch, volume, style) {
    let directiveCount = 0;
    const MAX_DIRECTIVES = 50;
    let totalPauseMs = 0;
    const MAX_PAUSE_MS = 30000;
    const MAX_SINGLE_PAUSE_MS = 5000;

    function clampPause(ms) {
        ms = Math.min(ms, MAX_SINGLE_PAUSE_MS);
        if (totalPauseMs + ms > MAX_PAUSE_MS) {
            ms = Math.max(0, MAX_PAUSE_MS - totalPauseMs);
        }
        totalPauseMs += ms;
        return ms;
    }

    function parsePauseValue(val) {
        if (!val) return 500;
        val = val.trim().toLowerCase();
        const strengthMap = { 'x-weak': 100, 'weak': 250, 'medium': 500, 'strong': 1000, 'x-strong': 2000 };
        if (strengthMap[val] !== undefined) return strengthMap[val];
        if (val.endsWith('ms')) return parseInt(val) || 500;
        if (val.endsWith('s')) return Math.round((parseFloat(val) || 0.5) * 1000);
        return parseInt(val) || 500;
    }

    function parsePauseStrength(val) {
        if (!val) return 'medium';
        val = val.trim().toLowerCase();
        const valid = ['x-weak', 'weak', 'medium', 'strong', 'x-strong'];
        return valid.includes(val) ? val : null;
    }

    function validateProsodyValue(val, type) {
        if (!val) return null;
        val = val.trim();
        if (type === 'rate') {
            const valid = ['x-slow', 'slow', 'medium', 'fast', 'x-fast'];
            if (valid.includes(val)) return val;
            if (/^[+-]\d+%$/.test(val)) return val;
            return null;
        }
        if (type === 'pitch') {
            const valid = ['x-low', 'low', 'medium', 'high', 'x-high'];
            if (valid.includes(val)) return val;
            if (/^[+-]\d+(?:Hz|%|st)$/.test(val)) return val;
            return null;
        }
        if (type === 'volume') {
            const valid = ['silent', 'soft', 'medium', 'loud', 'x-loud'];
            if (valid.includes(val)) return val;
            if (/^[+-]\d+dB$/.test(val)) return val;
            return null;
        }
        return null;
    }

    function validateEmphasisLevel(val) {
        if (!val) return 'moderate';
        val = val.trim().toLowerCase();
        const valid = ['reduced', 'moderate', 'strong', 'x-strong'];
        return valid.includes(val) ? val : null;
    }

    function validateSayAs(val) {
        if (!val) return null;
        val = val.trim().toLowerCase();
        const valid = ['digits', 'telephone', 'date', 'characters', 'cardinal', 'ordinal'];
        return valid.includes(val) ? val : null;
    }

    function escapeXmlAttr(val) {
        return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Phase 1: Convert self-closing pause tags
    let result = text.replace(/\[pause(?::([^\]]*))?\]/gi, function(_, val) {
        directiveCount++;
        if (directiveCount > MAX_DIRECTIVES) return _;
        const strength = parsePauseStrength(val);
        if (strength) {
            const ms = parsePauseValue(val);
            const clamped = clampPause(ms);
            return `<break time="${clamped}ms"/>`;
        }
        const ms = parsePauseValue(val);
        const clamped = clampPause(ms);
        return `<break time="${clamped}ms"/>`;
    });

    // Phase 2: Convert paired tags
    const pairedTags = [
        { name: 'emphasis', re: /\[emphasis(?::([^\]]*))?\]([\s\S]*?)\[\/emphasis\]/gi, convert(v, c) {
            const level = validateEmphasisLevel(v);
            if (!level) return null;
            return `<emphasis level="${level}">${c}</emphasis>`;
        }},
        { name: 'rate', re: /\[rate(?::([^\]]*))?\]([\s\S]*?)\[\/rate\]/gi, convert(v, c) {
            const rv = validateProsodyValue(v, 'rate');
            if (!rv) return null;
            return `<prosody rate="${rv}">${c}</prosody>`;
        }},
        { name: 'pitch', re: /\[pitch(?::([^\]]*))?\]([\s\S]*?)\[\/pitch\]/gi, convert(v, c) {
            const pv = validateProsodyValue(v, 'pitch');
            if (!pv) return null;
            return `<prosody pitch="${pv}">${c}</prosody>`;
        }},
        { name: 'volume', re: /\[volume(?::([^\]]*))?\]([\s\S]*?)\[\/volume\]/gi, convert(v, c) {
            const vv = validateProsodyValue(v, 'volume');
            if (!vv) return null;
            return `<prosody volume="${vv}">${c}</prosody>`;
        }},
        { name: 'style', re: /\[style(?::([^:\]]+)(?::([\d.]+))?)?\]([\s\S]*?)\[\/style\]/gi, convert(v, degree, c) {
            if (!v) return null;
            const styleName = v.trim();
            const degreeNum = degree ? parseFloat(degree) : null;
            if (degreeNum !== null && (degreeNum < 0.01 || degreeNum > 2.0)) return null;
            let attrs = `style="${escapeXmlAttr(styleName)}"`;
            if (degreeNum !== null) attrs += ` styledegree="${degreeNum}"`;
            return `<mstts:express-as ${attrs}>${c}</mstts:express-as>`;
        }},
        { name: 'say-as', re: /\[say-as(?::([^\]]*))?\]([\s\S]*?)\[\/say-as\]/gi, convert(v, c) {
            const sa = validateSayAs(v);
            if (!sa) return null;
            let attrs = `interpret-as="${sa}"`;
            if (sa === 'date') attrs += ' format="ymd"';
            return `<say-as ${attrs}>${c}</say-as>`;
        }},
        { name: 'sub', re: /\[sub(?::([^\]]*))?\]([\s\S]*?)\[\/sub\]/gi, convert(v, c) {
            if (!v || !v.trim()) return null;
            return `<sub alias="${escapeXmlAttr(v.trim())}">${c}</sub>`;
        }}
    ];

    for (const tag of pairedTags) {
        result = result.replace(tag.re, function(_, ...args) {
            directiveCount++;
            if (directiveCount > MAX_DIRECTIVES) return _;
            const content = args[args.length - 2];
            const values = args.slice(0, -2);
            const converted = tag.convert(...values, content);
            return converted !== null ? converted : _;
        });
    }

    // Wrap in SSML
    return getSsml(result, voiceName, rate, pitch, volume, style, 0, true);
}

export async function getVoiceSsml(ssml, outputFormat = 'audio-24khz-48kbitrate-mono-mp3', maxRetries = 3) {
    const retryDelay = 500;

    if (!ssml || !ssml.trim()) {
        return new Response(JSON.stringify({
            error: { message: "SSML 内容为空", type: "invalid_request_error", code: "empty_ssml" }
        }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
    }

    if (ssml.length > 8192) {
        return new Response(JSON.stringify({
            error: { message: "SSML 内容超过 8KB 限制", type: "invalid_request_error", code: "ssml_too_large" }
        }), { status: 400, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: ssml
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (response.status === 429) {
                    if (attempt < maxRetries) {
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
                } else if (response.status >= 500) {
                    if (attempt < maxRetries) {
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
                } else {
                    throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
                }
            }

            const audioBlob = await response.blob();
            const contentType = outputFormat.includes('opus') ? 'audio/opus' :
                                outputFormat.includes('riff') || outputFormat.includes('pcm') ? 'audio/wav' :
                                'audio/mpeg';
            return new Response(audioBlob, {
                headers: { "Content-Type": contentType, ...makeCORSHeaders() }
            });

        } catch (error) {
            if (attempt === maxRetries) {
                return new Response(JSON.stringify({
                    error: { message: `SSML 生成失败: ${error.message}`, type: "api_error", code: "ssml_error" }
                }), { status: 500, headers: { "Content-Type": "application/json", ...makeCORSHeaders() } });
            }
            if (error.message.includes('fetch') || error.message.includes('network')) {
                await delay(retryDelay * (attempt + 1));
                continue;
            }
            throw error;
        }
    }
}

function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0, raw = false) {
    const content = raw ? text : escapeXmlText(text);
    
    let slien_str = '';
    if (slien > 0) {
        slien_str = `<break time="${slien}ms" />`
    }
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
                <voice name="${voiceName}"> 
                    <mstts:express-as style="${style}"  styledegree="2.0" role="default" > 
                        <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${content}</prosody> 
                    </mstts:express-as> 
                    ${slien_str}
                </voice> 
            </speak>`;
}
