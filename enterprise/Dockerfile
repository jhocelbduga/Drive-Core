FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG SERVICE
WORKDIR /source
COPY global.json Directory.Build.props ./
COPY src ./src
RUN dotnet publish src/${SERVICE}/${SERVICE}.csproj --configuration Release --output /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
ARG SERVICE
ENV SERVICE=${SERVICE} ASPNETCORE_HTTP_PORTS=8080
WORKDIR /app
COPY --from=build /out ./
COPY infra/service-entrypoint.sh /entrypoint.sh
USER app
EXPOSE 8080
ENTRYPOINT ["sh", "/entrypoint.sh"]
