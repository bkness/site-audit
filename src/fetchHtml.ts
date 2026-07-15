export async function fetchHtml(url: string): Promise<string> {
    const parsedUrl = new URL(url);

    const response = await fetch(parsedUrl, {
        headers: {
            'user-agent': 'site-audit/1.0',
            accept: 'text/html,application/xhtml+xml'
        },
        redirect: 'follow'
    });

    if (!response.ok) {
        throw new Error(`Request failed with ${response.status} ${response.statusText}`);
    }

    return await response.text();
}
