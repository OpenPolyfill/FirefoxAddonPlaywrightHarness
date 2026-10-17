<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { SITE_NAME } from '#lib/site.js';

	const docsUrl = resolve('/docs');

	onMount(() => {
		window.location.replace(docsUrl);
	});
</script>

<svelte:head>
	<title>{SITE_NAME} documentation</title>
	<meta name="description" content="Redirecting to the Firefox Addon Playwright Harness documentation." />
	<meta http-equiv="refresh" content={`0; url=${docsUrl}`} />
	<link rel="canonical" href={docsUrl} />
</svelte:head>

<main aria-live="polite">
	<p>Redirecting to the <a href={docsUrl}>documentation</a>…</p>
</main>

<style>
	main {
		display: grid;
		min-height: 100vh;
		place-items: center;
		padding: 2rem;
		color: var(--text-soft);
		font-family: var(--font-sans, system-ui, sans-serif);
	}

	a {
		color: var(--accent-strong);
	}
</style>
