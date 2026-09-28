const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const { CloudFrontClient, CreateDistributionCommand, GetDistributionCommand, UpdateDistributionCommand, DeleteDistributionCommand } = require("@aws-sdk/client-cloudfront");

const app = express();
app.use(cors());
app.use(express.json());
app.set('trust proxy', true);

// --- CONEXIÓN DB ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// --- CONFIG AWS ---
const cfClient = new CloudFrontClient({
    region: "us-east-1", 
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const ADSPECT_AUTH_HEADER = process.env.ADSPECT_AUTH;
const WAF_ACL_ARN = process.env.WAF_ACL_ARN; 

// ==========================================
// FUNCIONES DE INFRAESTRUCTURA (AWS & ADSPECT)
// ==========================================

async function crearCloudFront(origenUrl, usarWaf = true) {
    try {
        let urlObj;
        try { const u = new URL(origenUrl.startsWith('http') ? origenUrl : `https://${origenUrl}`); urlObj = u; } 
        catch (e) { throw new Error("URL inválida"); }

        const domainOrigin = urlObj.hostname; 
        
        let rutaDestino = urlObj.pathname;
        if (rutaDestino !== '/' && !rutaDestino.endsWith('/')) {
            rutaDestino += '/';
        }

        const originId = `Nexus-${Math.random().toString(36).substring(7)}`;
        const callerRef = Date.now().toString(); 

        if (usarWaf && !WAF_ACL_ARN) console.warn("⚠️ ALERTA: WAF_ACL_ARN no definido.");

        const distribConfig = {
            CallerReference: callerRef,
            Comment: `Nexus: ${domainOrigin} ${usarWaf ? '(Con WAF)' : '(Staff Libre)'}`,
            Enabled: true,
            Origins: {
                Quantity: 1,
                Items: [{
                    Id: originId,
                    DomainName: domainOrigin, 
                    OriginPath: '', // <--- MANTIENE LA MAGIA ORIGINAL INTACTA
                    CustomOriginConfig: {
                        HTTPPort: 80, HTTPSPort: 443,
                        OriginProtocolPolicy: "https-only", 
                        OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] }
                    }
                }]
            },
            DefaultCacheBehavior: {
                TargetOriginId: originId,
                ViewerProtocolPolicy: "redirect-to-https",
                AllowedMethods: { 
                    Quantity: 7, 
                    Items: ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS", "DELETE"],
                    CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] }
                },
                ForwardedValues: { 
                    QueryString: true, 
                    Cookies: { Forward: "all" },
                    Headers: { Quantity: 0 } 
                },
                MinTTL: 0,
                DefaultTTL: 0, 
                MaxTTL: 0      
            }
        };

        if (usarWaf && WAF_ACL_ARN) {
            distribConfig.WebACLId = WAF_ACL_ARN;
        }

        const command = new CreateDistributionCommand({ DistributionConfig: distribConfig });
        const response = await cfClient.send(command);
        
        return {
            id: response.Distribution.Id,
            url: `https://${response.Distribution.DomainName}${rutaDestino}`,
            etag: response.Distribution.ETag
        };
    } catch (e) {
        console.error("❌ Error AWS Create:", e);
        return null;
    }
}

// ==========================================
// NUEVA INSTANCIA: CLOUDFRONT PARA SMS (RUTAS CORTAS)
// ==========================================
async function crearCloudFrontSMS(origenUrl) {
    try {
        let urlObj;
        try { const u = new URL(origenUrl.startsWith('http') ? origenUrl : `https://${origenUrl}`); urlObj = u; } 
        catch (e) { throw new Error("URL inválida"); }

        const domainOrigin = urlObj.hostname; 
        
        // Limpiamos el OriginPath para que AWS apunte directamente al directorio
        let pathParaOrigin = urlObj.pathname;
        if (pathParaOrigin.endsWith('/')) {
            pathParaOrigin = pathParaOrigin.slice(0, -1);
        }
        if (pathParaOrigin.endsWith('autorizador.php')) {
            pathParaOrigin = pathParaOrigin.replace('/autorizador.php', '');
        }

        const originId = `NexusSMS-${Math.random().toString(36).substring(7)}`;
        const callerRef = Date.now().toString(); 

        const distribConfig = {
            CallerReference: callerRef,
            Comment: `Nexus SMS Buffer: ${domainOrigin}${pathParaOrigin}`,
            Enabled: true,
            Origins: {
                Quantity: 1,
                Items: [{
                    Id: originId,
                    DomainName: domainOrigin, 
                    OriginPath: pathParaOrigin, // <--- MAGIA NUEVA: ENRUTAMIENTO INTERNO AWS
                    CustomOriginConfig: {
                        HTTPPort: 80, HTTPSPort: 443,
                        OriginProtocolPolicy: "https-only", 
                        OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] }
                    }
                }]
            },
            DefaultCacheBehavior: {
                TargetOriginId: originId,
                ViewerProtocolPolicy: "redirect-to-https",
                AllowedMethods: { 
                    Quantity: 7, 
                    Items: ["GET", "HEAD", "POST", "PUT", "PATCH", "OPTIONS", "DELETE"],
                    CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] }
                },
                ForwardedValues: { 
                    QueryString: true, 
                    Cookies: { Forward: "all" },
                    Headers: { Quantity: 0 } 
                },
                MinTTL: 0, DefaultTTL: 0, MaxTTL: 0      
            }
        };

        const command = new CreateDistributionCommand({ DistributionConfig: distribConfig });
        const response = await cfClient.send(command);
        
        return {
            id: response.Distribution.Id,
            // DEVUELVE ÚNICAMENTE EL DOMINIO BASE (Ej: https://d12345.cloudfront.net)
            url: `https://${response.Distribution.DomainName}`,
            etag: response.Distribution.ETag
        };
    } catch (e) {
        console.error("❌ Error AWS Create SMS:", e);
        return null;
    }
}
// ==========================================

async function desactivarCloudFront(distId) {
    try {
        const getCmd = new GetDistributionCommand({ Id: distId });
        const getRes = await cfClient.send(getCmd);
        const config = getRes.Distribution.DistributionConfig;
        
        if (!config.Enabled) return { success: true, newEtag: getRes.ETag };
        
        config.Enabled = false; 
        const updateRes = await cfClient.send(new UpdateDistributionCommand({
            Id: distId,
            IfMatch: getRes.ETag,
            DistributionConfig: config
        }));
        
        return { success: true, newEtag: updateRes.ETag };
    } catch (e) { 
        return { success: false }; 
    }
}

async function eliminarCloudFrontFinal(distId) {
    try {
        const getCmd = new GetDistributionCommand({ Id: distId });
        const getRes = await cfClient.send(getCmd);
        if (getRes.Distribution.Status === 'Deployed' && getRes.Distribution.DistributionConfig.Enabled === false) {
            await cfClient.send(new DeleteDistributionCommand({ Id: distId, IfMatch: getRes.ETag }));
            return true;
        } 
        return false;
    } catch (e) { 
        if (e.name === 'NoSuchDistribution') return true; 
        return false; 
    }
}

async function rotarAdspect(streamId, targetUrl) {
    if (!ADSPECT_AUTH_HEADER) {
        console.error("⚠️ ALERTA: La variable de entorno ADSPECT_AUTH no está definida en Railway.");
        return false;
    }
    if (!streamId) return false;
    
    try {
        const config = { headers: { 'Authorization': ADSPECT_AUTH_HEADER, 'Content-Type': 'application/json', 'Accept': 'application/json' } };
        const payload = {
            money_pages: [{ 
                page: targetUrl, 
                action: "meta", 
                arg_passthru: true, 
                weight: 1, 
                enabled: true 
            }]
        };
        await axios.patch(`https://api.adspect.net/v1/streams/${streamId}`, payload, config);
        console.log(`✅ Adspect actualizado a: ${targetUrl}`);
        return true;
    } catch (error) { 
        // AHORA SÍ VEREMOS POR QUÉ ADSPECT ESTÁ RECHAZANDO LA PETICIÓN
        console.error("❌ ERROR CRÍTICO API ADSPECT:");
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", JSON.stringify(error.response.data));
        } else {
            console.error("Mensaje:", error.message);
        }
        return false; 
    }
}

async function cambiarModoAdspect(streamId, modo) {
    if (!ADSPECT_AUTH_HEADER || !streamId) return false;
    try {
        const config = { headers: { 'Authorization': ADSPECT_AUTH_HEADER, 'Content-Type': 'application/json', 'Accept': 'application/json' } };
        await axios.patch(`https://api.adspect.net/v1/streams/${streamId}`, { mode: modo }, config);
        return true;
    } catch (error) { 
        return false; 
    }
}

// ==========================================
// API ENDPOINTS (ROTADORES DE CAMPAÑA)
// ==========================================

app.get('/api/active-mirror/:nombre', async (req, res) => {
    const { nombre } = req.params;
    try {
        const searchTerm = `%${nombre}%`; 
        const result = await pool.query(
            `SELECT e.url_publica 
             FROM espejos e 
             JOIN campanas c ON e.campana_id = c.id 
             WHERE c.nombre_interno ILIKE $1 AND e.estado = 'ACTIVO' 
             ORDER BY e.id DESC LIMIT 1`, 
            [searchTerm]
        );
        if (result.rows.length > 0) {
            res.json({ success: true, url: result.rows[0].url_publica });
        } else {
            res.status(404).json({ success: false, message: "No hay espejo activo" });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/entry/:campanaId', async (req, res) => {
    const { campanaId } = req.params;
    try {
        const espejo = await pool.query("SELECT url_publica FROM espejos WHERE campana_id = $1 AND estado = 'ACTIVO' LIMIT 1", [campanaId]);
        if (espejo.rows.length === 0) return res.status(404).send("<h1>Enlace no disponible.</h1>");
        res.redirect(espejo.rows[0].url_publica);
    } catch (e) { res.status(500).send("Error de acceso"); }
});

app.get('/api/reset-db', async (req, res) => {
    try {
        await pool.query('DROP TABLE IF EXISTS espejos CASCADE');
        await pool.query('DROP TABLE IF EXISTS campanas CASCADE');
        await pool.query(`CREATE TABLE IF NOT EXISTS campanas (id SERIAL PRIMARY KEY, nombre_interno VARCHAR(255) NOT NULL, tipo_rotacion VARCHAR(50) NOT NULL, stream_id VARCHAR(100), prefijo_bunny VARCHAR(100) NOT NULL, origen_url TEXT NOT NULL, estado VARCHAR(50) DEFAULT 'ACTIVA', fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ultimo_cambio TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS espejos (id SERIAL PRIMARY KEY, campana_id INTEGER REFERENCES campanas(id) ON DELETE CASCADE, bunny_zone_id VARCHAR(100), nombre_zona VARCHAR(255), url_publica VARCHAR(255), token_key VARCHAR(255), estado VARCHAR(50) DEFAULT 'DISPONIBLE');`);
        res.send("<h1>✅ DB Restaurada.</h1>");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/campanas', async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.*, e.url_publica as espejo_actual FROM campanas c LEFT JOIN espejos e ON c.id = e.campana_id AND e.estado = 'ACTIVO' ORDER BY c.fecha_creacion DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/crear-campana', async (req, res) => {
    const { nombre, tipo, stream_id, prefijo, origen } = req.body;
    if (!process.env.AWS_ACCESS_KEY_ID) return res.status(500).json({ error: "Faltan credenciales AWS" });
    try {
        const campRes = await pool.query(`INSERT INTO campanas (nombre_interno, tipo_rotacion, stream_id, prefijo_bunny, origen_url, ultimo_cambio, estado) VALUES ($1, $2, $3, $4, $5, NOW(), 'ACTIVA') RETURNING id`, [nombre, tipo, stream_id, prefijo, origen]);
        const campanaId = campRes.rows[0].id;
        
        if (stream_id) await cambiarModoAdspect(stream_id, "Filter");
        
        const nuevaZona = await crearCloudFront(origen);
        
        if (nuevaZona) {
            await pool.query(`INSERT INTO espejos (campana_id, bunny_zone_id, nombre_zona, url_publica, token_key, estado) VALUES ($1, $2, 'CloudFront', $3, $4, 'ACTIVO')`, [campanaId, nuevaZona.id, nuevaZona.url, nuevaZona.etag]);
            if (stream_id) await rotarAdspect(stream_id, nuevaZona.url);
            
            res.json({ success: true, message: "Campaña iniciada." });
        } else {
            await pool.query('DELETE FROM campanas WHERE id = $1', [campanaId]);
            res.status(500).json({ error: "Fallo AWS." });
        }
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/crear-empresa-directa', async (req, res) => {
    const { nombre, tipo, stream_id, prefijo, origen } = req.body;
    if (!process.env.AWS_ACCESS_KEY_ID) return res.status(500).json({ error: "Faltan credenciales AWS" });
    
    try {
        const campRes = await pool.query(
            `INSERT INTO campanas (nombre_interno, tipo_rotacion, stream_id, prefijo_bunny, origen_url, ultimo_cambio, estado) 
             VALUES ($1, $2, $3, $4, $5, NOW(), 'ACTIVA') RETURNING id`, 
            [nombre, tipo, stream_id, prefijo, origen]
        );
        const campanaId = campRes.rows[0].id;
        
        if (stream_id) await cambiarModoAdspect(stream_id, "Filter");
        
        const nuevaZona = await crearCloudFront(origen, true);
        
        if (nuevaZona) {
            await pool.query(
                `INSERT INTO espejos (campana_id, bunny_zone_id, nombre_zona, url_publica, token_key, estado) 
                 VALUES ($1, $2, 'CloudFront (Empresas Directas)', $3, $4, 'ACTIVO')`, 
                [campanaId, nuevaZona.id, nuevaZona.url, nuevaZona.etag]
            );
            if (stream_id) await rotarAdspect(stream_id, nuevaZona.url);
            
            res.json({ success: true, message: "Campaña Empresas Directas desplegada." });
        } else {
            await pool.query('DELETE FROM campanas WHERE id = $1', [campanaId]);
            res.status(500).json({ error: "Fallo AWS." });
        }
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/campanas/:id/toggle', async (req, res) => {
    const { id } = req.params;
    try {
        const campana = await pool.query("SELECT * FROM campanas WHERE id = $1", [id]);
        if (campana.rows.length === 0) return res.status(404).json({ error: "No existe" });
        const actual = campana.rows[0];
        const nuevoEstado = actual.estado === 'ACTIVA' ? 'PAUSADA' : 'ACTIVA';
        
        if (actual.stream_id) await cambiarModoAdspect(actual.stream_id, nuevoEstado === 'PAUSADA' ? "Safe" : "Filter");
        await pool.query("UPDATE campanas SET estado = $1 WHERE id = $2", [nuevoEstado, id]);
        
        res.json({ success: true, nuevo_estado: nuevoEstado });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/acciones/pausar-todo', async (req, res) => {
    try {
        const activas = await pool.query("SELECT * FROM campanas WHERE estado = 'ACTIVA'");
        for (const camp of activas.rows) {
            if (camp.stream_id) await cambiarModoAdspect(camp.stream_id, "Safe");
            await pool.query("UPDATE campanas SET estado = 'PAUSADA' WHERE id = $1", [camp.id]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/acciones/purgar-todo', async (req, res) => {
    try {
        const espejos = await pool.query("SELECT bunny_zone_id FROM espejos");
        for (const row of espejos.rows) if (row.bunny_zone_id) await desactivarCloudFront(row.bunny_zone_id);
        const campañas = await pool.query("SELECT stream_id FROM campanas WHERE stream_id IS NOT NULL");
        for (const c of campañas.rows) await cambiarModoAdspect(c.stream_id, "Safe");
        await pool.query('TRUNCATE TABLE campanas, espejos RESTART IDENTITY CASCADE');
        res.json({ success: true, message: "Purgado." });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/campanas/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const c = await pool.query("SELECT stream_id FROM campanas WHERE id=$1", [id]);
        if(c.rows.length > 0 && c.rows[0].stream_id) await cambiarModoAdspect(c.rows[0].stream_id, "Safe");
        const espejos = await pool.query('SELECT bunny_zone_id FROM espejos WHERE campana_id = $1', [id]);
        for (const row of espejos.rows) await desactivarCloudFront(row.bunny_zone_id);
        await pool.query('DELETE FROM campanas WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// ENDPOINTS: ESPEJOS ESTÁTICOS (STAFF)
// ==========================================

app.post('/api/crear-acceso-staff', async (req, res) => {
    const { alias, targetUrl } = req.body;
    if (!targetUrl) return res.status(400).json({ error: "Falta targetUrl" });

    try {
        console.log(`🛡️ Desplegando espejo estático para Staff: ${alias}`);
        const nuevaZona = await crearCloudFront(targetUrl, false);
        
        if (nuevaZona) {
            res.json({ success: true, url: nuevaZona.url, distId: nuevaZona.id });
        } else {
            res.status(500).json({ error: "Fallo AWS al crear la distribución." });
        }
    } catch (error) { 
        console.error("Error en crear-acceso-staff:", error);
        res.status(500).json({ error: error.message }); 
    }
});

// ==========================================
// NUEVO ENDPOINT: BUFFER SMS
// ==========================================
app.post('/api/crear-acceso-sms', async (req, res) => {
    const { targetUrl } = req.body;
    if (!targetUrl) return res.status(400).json({ error: "Falta targetUrl" });

    try {
        console.log(`📱 Desplegando espejo SMS ultracorto para: ${targetUrl}`);
        const nuevaZona = await crearCloudFrontSMS(targetUrl);
        
        if (nuevaZona) {
            res.json({ success: true, url: nuevaZona.url, distId: nuevaZona.id });
        } else {
            res.status(500).json({ error: "Fallo AWS al crear la distribución SMS." });
        }
    } catch (error) { 
        console.error("Error en crear-acceso-sms:", error);
        res.status(500).json({ error: error.message }); 
    }
});
// ==========================================

app.post('/api/borrar-acceso-staff', async (req, res) => {
    const { distId } = req.body;
    if (!distId) return res.status(400).json({ error: "Falta distId" });

    try {
        console.log(`💥 Desactivando espejo: ${distId}`);
        const resultado = await desactivarCloudFront(distId);
        
        if (resultado.success) {
            await pool.query("INSERT INTO espejos (bunny_zone_id, nombre_zona, estado) VALUES ($1, 'Staff Eliminado', 'DESACTIVADO')", [distId]);
        }
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// ==========================================
// CRON JOBS
// ==========================================

cron.schedule('* * * * *', async () => {
    try {
        const campañas = await pool.query("SELECT * FROM campanas WHERE estado = 'ACTIVA'");
        for (const camp of campañas.rows) {
            const ultimoCambio = new Date(camp.ultimo_cambio);
            const diferenciaMinutos = (new Date() - ultimoCambio) / 1000 / 60;
            const intervalo = Math.max(parseInt(camp.tipo_rotacion), 10); 
            const tiempoPreparacion = intervalo - 4;

            const pendienteRes = await pool.query("SELECT * FROM espejos WHERE campana_id = $1 AND estado = 'PENDIENTE' LIMIT 1", [camp.id]);
            const espejoPendiente = pendienteRes.rows.length > 0 ? pendienteRes.rows[0] : null;

            if (!espejoPendiente && diferenciaMinutos >= tiempoPreparacion) {
                console.log(`🛠️ PREPARANDO: ${camp.nombre_interno}`);
                const nuevaZona = await crearCloudFront(camp.origen_url);
                if (nuevaZona) {
                    await pool.query("INSERT INTO espejos (campana_id, bunny_zone_id, nombre_zona, url_publica, token_key, estado) VALUES ($1, $2, 'CloudFront (Pendiente)', $3, $4, 'PENDIENTE')", [camp.id, nuevaZona.id, nuevaZona.url, nuevaZona.etag]);
                }
            }

            if (espejoPendiente && diferenciaMinutos >= intervalo) {
                console.log(`🔄 ROTANDO: ${camp.nombre_interno}`);
                if (camp.stream_id) await rotarAdspect(camp.stream_id, espejoPendiente.url_publica);
                await pool.query("UPDATE espejos SET estado = 'ACTIVO', nombre_zona = 'CloudFront' WHERE id = $1", [espejoPendiente.id]);
                await pool.query("UPDATE campanas SET ultimo_cambio = NOW() WHERE id = $1", [camp.id]);
                
                const viejos = await pool.query("SELECT * FROM espejos WHERE campana_id = $1 AND estado = 'ACTIVO' AND id != $2", [camp.id, espejoPendiente.id]);
                for (const viejo of viejos.rows) {
                    const res = await desactivarCloudFront(viejo.bunny_zone_id);
                    if (res.success) await pool.query("UPDATE espejos SET estado = 'DESACTIVADO', token_key = $1 WHERE id = $2", [res.newEtag, viejo.id]);
                }
            }
        }
        
        const basura = await pool.query("SELECT * FROM espejos WHERE estado = 'DESACTIVADO'");
        for (const item of basura.rows) {
            const borrado = await eliminarCloudFrontFinal(item.bunny_zone_id);
            if (borrado) await pool.query("UPDATE espejos SET estado = 'ELIMINADO' WHERE id = $1", [item.id]);
        }
    } catch (error) { 
        console.error("Error Cron Infra:", error); 
    }
});

cron.schedule('* * * * *', async () => {
    try {
        const panelUrl = 'https://www.centrodecontrol.top/panel/api/cron_autopilot.php';
        const res = await axios.get(panelUrl);
        if (res.data && res.data.includes("clientes rescatados") && !res.data.includes("0 clientes")) {
            console.log(`🤖 Bot Triggered: ${res.data}`);
        }
    } catch (error) { 
        console.error("⚠️ Error Bot:", error.message); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🔥 Nexus iniciado y escuchando en el puerto ${PORT}`);
});
